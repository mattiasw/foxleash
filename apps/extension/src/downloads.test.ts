import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { DOWNLOAD_MAX_BYTES } from "@foxleash/protocol";
import type { RequestDetails } from "./browser-api.ts";
import {
  createDownloads,
  DOWNLOAD_TIMEOUT_MS,
  downloadNameProblem,
  LATE_HOP_MS,
  MAX_DOWNLOAD_NAME_BYTES,
} from "./downloads.ts";
import {
  createFakeBrowser,
  createFakeTimers,
  FAKE_DOWNLOAD_FOLDER,
  flush,
} from "./fake-browser.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite, revokeSite } from "./settings.ts";
import { createSiteAccess, type SessionMemory, type SiteView } from "./site-access.ts";

const SITE = "https://a.example";
const OTHER = "https://b.example";
const UNAPPROVED = "https://c.example";
const BLOCKED = "https://www.paypal.com";
const URL_A = `${SITE}/r/receipt`;
const BYTES = new TextEncoder().encode("%PDF-1.4 receipt");
const WRITE_FAILED = {
  code: "download_failed",
  message: "Firefox could not write the file to the download folder.",
};
const FETCH_FAILED = {
  code: "download_failed",
  message: "Firefox could not fetch the file; nothing was saved.",
};
const TIMED_OUT = {
  code: "download_timeout",
  message: "The download did not finish within 50 seconds.",
};

describe("download", { timeout: 10000 }, () => {
  it("refuses a start URL on a site the session may not act on, before any request", async () => {
    const { downloads, fetchCalls } = await setup();
    await assert.rejects(downloads.save("s1", `${UNAPPROVED}/x`, "x.pdf", 0), {
      code: "site_not_approved",
      message: `Foxleash is not allowed on ${UNAPPROVED} in this session; open it with tab_open or navigate first, which asks the user.`,
    });
    assert.deepEqual(fetchCalls, []);
  });

  it("refuses a start URL on a blocked site, approved or not, before any request", async () => {
    const { fake, downloads, fetchCalls } = await setup();
    await assert.rejects(downloads.save("s1", `${BLOCKED}/x`, "x.pdf", 0), {
      code: "site_blocked",
    });
    await grantSite(fake.browser, BLOCKED);
    await assert.rejects(downloads.save("s1", `${BLOCKED}/x`, "x.pdf", 0), {
      code: "site_blocked",
      message: `Foxleash does not act on ${BLOCKED}: it is on Foxleash's blocklist, which by default lists common financial and health sites.`,
    });
    assert.deepEqual(fetchCalls, []);
  });

  it("takes a site the user approved for this session only", async () => {
    const { downloads, sessions, respondWith } = await setup();
    sessions.set("s1", { allowed: new Set([UNAPPROVED]), refused: new Set(), closed: 0 });
    respondWith(() => response(`${UNAPPROVED}/x`, BYTES));
    assert.equal((await downloads.save("s1", `${UNAPPROVED}/x`, "x.pdf", 0)).bytes, BYTES.length);
    await assert.rejects(downloads.save("s2", `${UNAPPROVED}/x`, "x.pdf", 0), {
      code: "site_not_approved",
    });
  });

  it("fetches with the user's cookies, saves the bytes under the name and returns the file", async () => {
    const { fake, downloads, fetchCalls, blobs, revoked, timers } = await setup();
    const result = await downloads.save("s1", URL_A, "receipt.pdf", 0);
    assert.deepEqual(result, {
      path: `${FAKE_DOWNLOAD_FOLDER}/receipt.pdf`,
      bytes: BYTES.length,
    });
    assert.equal(fetchCalls.length, 1);
    const [call] = fetchCalls;
    assert.equal(call?.url, URL_A);
    assert.deepEqual(Object.keys(call?.init ?? {}).sort(), ["cache", "credentials", "signal"]);
    assert.equal(call?.init.credentials, "include");
    assert.equal(call?.init.cache, "no-store");
    const [objectUrl] = [...blobs.keys()];
    assert.deepEqual(fake.downloadCalls, [
      { url: objectUrl, filename: "receipt.pdf", saveAs: false, conflictAction: "uniquify" },
    ]);
    const blob = blobs.get(objectUrl ?? "");
    assert.equal(blob?.type, "");
    assert.deepEqual(new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0)), BYTES);
    assert.deepEqual(revoked, [objectUrl]);
    assert.equal(fake.downloadListenerCount(), 0);
    assert.equal(timers.pending(), 0);
  });

  it("saves the bytes of a body that arrives in several chunks", async () => {
    const { fake, downloads, blobs, respondWith } = await setup();
    const parts = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])];
    respondWith(() => response(URL_A, stream(parts).body));
    assert.equal((await downloads.save("s1", URL_A, "x.bin", 0)).bytes, 6);
    const blob = blobs.get(fake.downloadCalls[0]?.url ?? "");
    assert.deepEqual(
      new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0)),
      new Uint8Array([1, 2, 3, 4, 5, 6]),
    );
  });

  it("saves an empty file for a response without a body", async () => {
    const { fake, downloads, respondWith } = await setup();
    respondWith(() => response(URL_A, null, { status: 204 }));
    assert.deepEqual(await downloads.save("s1", URL_A, "empty.txt", 0), {
      path: `${FAKE_DOWNLOAD_FOLDER}/empty.txt`,
      bytes: 0,
    });
    assert.equal(fake.downloadCalls.length, 1);
  });

  it("refuses a redirect to a site withdrawn after its hop, before reading the body", async () => {
    const { fake, downloads, fetchCalls, respondWith } = await setup();
    const body = stream([BYTES]);
    respondWith(async (_init, redirect) => {
      await redirect(`${OTHER}/x`);
      await revokeSite(fake.browser, OTHER);
      return response(`${OTHER}/x`, body.body);
    });
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), {
      code: "site_not_approved",
      message: `The link led to ${OTHER}, which Foxleash is not allowed on in this session; nothing was saved.`,
    });
    assert.equal(body.pulled(), 0);
    assert.deepEqual(fake.downloadCalls, []);
    assert.equal(fetchCalls[0]?.init.signal.aborted, true);
  });

  it("cancels a redirect hop to a site the session may not act on", async () => {
    const { fake, downloads, requests, respondWith } = await setup();
    respondWith(async (_init, redirect) => {
      await redirect(`${UNAPPROVED}/x?q=1`);
      return response(`${UNAPPROVED}/x?q=1`, BYTES);
    });
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), {
      code: "site_not_approved",
      message: `The link led to ${UNAPPROVED}, which Foxleash is not allowed on in this session; nothing was requested there and nothing was saved.`,
    });
    assert.deepEqual(await Promise.all(requests[1]?.answers ?? []), [{ cancel: true }]);
    assert.deepEqual(fake.downloadCalls, []);
  });

  it("cancels a redirect hop to a blocked site, approved or not", async () => {
    const { fake, downloads, requests, respondWith } = await setup();
    respondWith(async (_init, redirect) => {
      await redirect(`${BLOCKED}/x`);
      return response(`${BLOCKED}/x`, BYTES);
    });
    const refusal = {
      code: "site_blocked",
      message: `The link led to ${BLOCKED}, which is on Foxleash's blocklist; nothing was requested there and nothing was saved.`,
    };
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), refusal);
    await grantSite(fake.browser, BLOCKED);
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), refusal);
    assert.deepEqual(await Promise.all(requests[3]?.answers ?? []), [{ cancel: true }]);
    assert.deepEqual(fake.downloadCalls, []);
  });

  it("cancels a redirect hop to an address that is not http(s)", async () => {
    const { fake, downloads, requests, respondWith } = await setup();
    for (const hop of ["ftp://a.example/x", "data:,x"]) {
      respondWith(async (_init, redirect) => {
        await redirect(hop);
        return response(hop, BYTES);
      });
      await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), FETCH_FAILED);
      assert.deepEqual(await Promise.all(requests.at(-1)?.answers ?? []), [{ cancel: true }]);
    }
    assert.deepEqual(fake.downloadCalls, []);
  });

  it("cancels a redirect hop when the site check fails", async () => {
    const { fake, downloads, access, requests, respondWith, failView } = await setup();
    failView(2, new Error("storage is gone"));
    respondWith(async (_init, redirect) => {
      await redirect(`${OTHER}/x`);
      return response(`${OTHER}/x`, BYTES);
    });
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), FETCH_FAILED);
    assert.deepEqual(await Promise.all(requests[1]?.answers ?? []), [{ cancel: true }]);
    respondWith(async (_init, redirect) => {
      access.stop("s1");
      await redirect(`${OTHER}/x`);
      return response(`${OTHER}/x`, BYTES);
    });
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), { code: "session_stopped" });
    assert.deepEqual(await Promise.all(requests[3]?.answers ?? []), [{ cancel: true }]);
    assert.deepEqual(fake.downloadCalls, []);
  });

  it("reads the site view anew for each redirect hop", async () => {
    const { fake, downloads, respondWith } = await setup();
    respondWith(async (_init, redirect) => {
      await redirect(`${OTHER}/a`);
      await revokeSite(fake.browser, OTHER);
      await redirect(`${OTHER}/b`);
      return response(`${OTHER}/b`, BYTES);
    });
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), {
      code: "site_not_approved",
      message: `The link led to ${OTHER}, which Foxleash is not allowed on in this session; nothing was requested there and nothing was saved.`,
    });
    assert.deepEqual(fake.downloadCalls, []);
  });

  it("refuses a response whose URL is not a web URL", async () => {
    const { fake, downloads, respondWith } = await setup();
    respondWith(() => response("", BYTES));
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), FETCH_FAILED);
    assert.deepEqual(fake.downloadCalls, []);
  });

  it("saves after a redirect on the same site or to another approved site", async () => {
    const { fake, downloads, requests, respondWith } = await setup();
    for (const final of [`${SITE}/other`, `${OTHER}/x`]) {
      respondWith(async (_init, redirect) => {
        await redirect(final);
        return response(final, BYTES);
      });
      assert.equal((await downloads.save("s1", URL_A, "x.pdf", 0)).bytes, BYTES.length);
    }
    assert.deepEqual(await Promise.all(requests[3]?.answers ?? []), [undefined]);
    assert.equal(fake.downloadCalls.length, 2);
  });

  it("saves nothing that came through a redirect the listener did not see", async () => {
    const { fake, downloads, respondWith } = await setup();
    const body = stream([BYTES]);
    respondWith(() => response(`${OTHER}/x`, body.body));
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), FETCH_FAILED);
    assert.equal(body.pulled(), 0);
    assert.deepEqual(fake.downloadCalls, []);
  });

  it("answers the fetch's first request, and every other request, at once with nothing", async () => {
    const { fake, downloads, background, requests, respondWith, holdView, views } = await setup();
    const release = holdView(1);
    respondWith(async (_init, redirect) => {
      await redirect(`${UNAPPROVED}/x`);
      return response(`${UNAPPROVED}/x`, BYTES);
    });
    const saving = downloads.save("s1", URL_A, "x.pdf", 0);
    await until(() => views() === 1);
    // A site's service worker asks for the same address first; it is not the download's fetch.
    const worker = fake.emitWebRequest("onBeforeRequest", request(URL_A, "w", `${SITE}/sw.js`));
    assert.equal(worker.length, 1);
    assert.equal(worker[0], undefined);
    // An own request before the fetch began is not the fetch either.
    const early = fake.emitWebRequest("onBeforeRequest", request(URL_A, "e", background));
    assert.equal(early.length, 1);
    assert.equal(early[0], undefined);
    assert.deepEqual(
      fake.emitWebRequest("onBeforeRequest", request(URL_A, "t", background, 5)),
      [],
    );
    release();
    await assert.rejects(saving, {
      code: "site_not_approved",
      message: `The link led to ${UNAPPROVED}, which Foxleash is not allowed on in this session; nothing was requested there and nothing was saved.`,
    });
    assert.equal(requests[0]?.answers.length, 1);
    assert.equal(requests[0]?.answers[0], undefined);
  });

  it("never takes a site's request during the fetch for the download's own", async () => {
    const { fake, downloads, respondWith, missFirstRequest } = await setup();
    missFirstRequest();
    let worker: unknown[] = [];
    respondWith(async (_init, redirect) => {
      worker = fake.emitWebRequest("onBeforeRequest", request(URL_A, "w", `${SITE}/sw.js`));
      await redirect(`${UNAPPROVED}/x`);
      return response(`${UNAPPROVED}/x`, BYTES);
    });
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), {
      code: "site_not_approved",
      message: `The link led to ${UNAPPROVED}, which Foxleash is not allowed on in this session; nothing was requested there and nothing was saved.`,
    });
    assert.equal(worker.length, 1);
    assert.equal(worker[0], undefined);
  });

  it("judges only the fetch's own requests once it has seen one", async () => {
    const { fake, downloads, background, respondWith } = await setup();
    let other: unknown[] = [];
    respondWith(async (_init, redirect) => {
      await redirect(`${OTHER}/x`);
      other = fake.emitWebRequest("onBeforeRequest", request(`${SITE}/y`, "2", background));
      return response(`${OTHER}/x`, BYTES);
    });
    assert.equal((await downloads.save("s1", URL_A, "x.pdf", 0)).bytes, BYTES.length);
    assert.equal(other.length, 1);
    assert.equal(other[0], undefined);
  });

  it("judges the first hop when the fetch's first request was not seen", async () => {
    const { fake, downloads, respondWith, missFirstRequest } = await setup();
    missFirstRequest();
    respondWith(async (_init, redirect) => {
      await redirect(`${UNAPPROVED}/x`);
      return response(`${UNAPPROVED}/x`, BYTES);
    });
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), {
      code: "site_not_approved",
      message: `The link led to ${UNAPPROVED}, which Foxleash is not allowed on in this session; nothing was requested there and nothing was saved.`,
    });
    respondWith(async (_init, redirect) => {
      await redirect(`${OTHER}/x`);
      return response(`${OTHER}/x`, BYTES);
    });
    assert.equal((await downloads.save("s1", URL_A, "x.pdf", 0)).bytes, BYTES.length);
    assert.equal(fake.downloadCalls.length, 1);
  });

  it("compares the fetch's addresses without their fragment", async () => {
    const { fake, downloads, requests, respondWith } = await setup();
    assert.equal((await downloads.save("s1", `${URL_A}#page=2`, "x.pdf", 0)).bytes, BYTES.length);
    assert.equal(requests[0]?.url, `${URL_A}#page=2`);
    // The first request, not judged as a hop.
    assert.equal(requests[0]?.answers.length, 1);
    assert.equal(requests[0]?.answers[0], undefined);
    respondWith(async (_init, redirect) => {
      await redirect(`${OTHER}/x#top`);
      return response(`${OTHER}/x`, BYTES);
    });
    assert.equal((await downloads.save("s1", `${URL_A}#page=2`, "x.pdf", 0)).bytes, BYTES.length);
    respondWith(async (_init, redirect) => {
      await redirect(`${UNAPPROVED}/x`);
      return response(`${UNAPPROVED}/x`, BYTES);
    });
    await assert.rejects(downloads.save("s1", `${URL_A}#page=2`, "x.pdf", 0), {
      code: "site_not_approved",
    });
    assert.equal(fake.downloadCalls.length, 2);
  });

  it("saves nothing when the user withdraws the site while the body arrives", async () => {
    const { fake, downloads, respondWith } = await setup();
    respondWith(() =>
      response(
        URL_A,
        stream([BYTES], async (index) => {
          if (index === 0) await revokeSite(fake.browser, SITE);
        }).body,
      ),
    );
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), {
      code: "site_not_approved",
      message: `The link led to ${SITE}, which Foxleash is not allowed on in this session; nothing was saved.`,
    });
    assert.deepEqual(fake.downloadCalls, []);
  });

  it("sends no request when the session ends during the first site check", async () => {
    const { downloads, access, fetchCalls, holdView, views } = await setup();
    const release = holdView(1);
    const saving = downloads.save("s1", URL_A, "x.pdf", access.generation("s1"));
    await until(() => views() === 1);
    access.endSession("s1");
    release();
    await assert.rejects(saving, {
      code: "session_ended",
      message: "The session ended before Foxleash could finish the request.",
    });
    assert.deepEqual(fetchCalls, []);
  });

  it("saves nothing when the session ends while the body arrives", async () => {
    const { fake, downloads, access, blobs, respondWith } = await setup();
    respondWith(() =>
      response(
        URL_A,
        stream([BYTES], (index) => {
          if (index === 0) access.endSession("s1");
        }).body,
      ),
    );
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", access.generation("s1")), {
      code: "session_ended",
    });
    assert.deepEqual(fake.downloadCalls, []);
    assert.equal(blobs.size, 0);
  });

  it("refuses a response that is not a success, with its status", async () => {
    const { fake, downloads, respondWith } = await setup();
    for (const status of [404, 403, 500, 301]) {
      respondWith(() => response(URL_A, "no", { status }));
      await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), {
        code: "download_failed",
        message: `The server answered with status ${status}; nothing was saved.`,
      });
    }
    assert.deepEqual(fake.downloadCalls, []);
  });

  it("names the site, not the status, for a failure on a site the session may not act on", async () => {
    const { fake, downloads, respondWith } = await setup();
    respondWith(async (_init, redirect) => {
      await redirect(`${OTHER}/missing`);
      await revokeSite(fake.browser, OTHER);
      return response(`${OTHER}/missing`, "no", { status: 404 });
    });
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), {
      code: "site_not_approved",
      message: `The link led to ${OTHER}, which Foxleash is not allowed on in this session; nothing was saved.`,
    });
  });

  it("refuses a Content-Length above the limit before reading the body", async () => {
    const { fake, downloads, respondWith } = await setup();
    const body = stream([BYTES]);
    respondWith(() =>
      response(URL_A, body.body, {
        headers: { "content-length": String(DOWNLOAD_MAX_BYTES + 1) },
      }),
    );
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), {
      code: "download_too_large",
      message: "The file is larger than 100 MiB; nothing was saved.",
    });
    assert.equal(body.pulled(), 0);
    assert.deepEqual(fake.downloadCalls, []);
  });

  it("saves a body of exactly the limit, and refuses one byte more while reading it", async () => {
    const { fake, downloads, fetchCalls, respondWith } = await setup();
    const quarter = new Uint8Array(DOWNLOAD_MAX_BYTES / 4);
    const full = [quarter, quarter, quarter, quarter];
    respondWith(() =>
      response(URL_A, stream(full).body, {
        headers: { "content-length": String(DOWNLOAD_MAX_BYTES) },
      }),
    );
    assert.equal((await downloads.save("s1", URL_A, "big.bin", 0)).bytes, DOWNLOAD_MAX_BYTES);
    const over = stream([...full, new Uint8Array(1), new Uint8Array(1)]);
    respondWith(() => response(URL_A, over.body));
    await assert.rejects(downloads.save("s1", URL_A, "big.bin", 0), {
      code: "download_too_large",
    });
    assert.equal(over.pulled(), 5);
    assert.equal(fetchCalls[1]?.init.signal.aborted, true);
    assert.equal(fake.downloadCalls.length, 1);
  });

  it("refuses a fetch that fails, and a body that fails while it arrives", async () => {
    const { fake, downloads, respondWith } = await setup();
    respondWith(() => Promise.reject(new TypeError("NetworkError when attempting to fetch")));
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), FETCH_FAILED);
    respondWith(() =>
      response(
        URL_A,
        stream([BYTES], (index) => {
          if (index === 1) throw new TypeError("network error");
        }).body,
      ),
    );
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), FETCH_FAILED);
    assert.deepEqual(fake.downloadCalls, []);
  });

  it("refuses a name Firefox will not save under, without passing on Firefox's text", async () => {
    const { fake, downloads, revoked } = await setup();
    fake.failNextDownload(new Error("filename must not contain illegal characters"));
    await assert.rejects(downloads.save("s1", URL_A, "x.desktop", 0), {
      code: "invalid_params",
      message:
        'Firefox would not save a file named "x.desktop"; choose a plain name with a usual extension, such as receipt.pdf.',
    });
    assert.equal(revoked.length, 1);
    assert.equal(fake.downloadListenerCount(), 0);
    assert.equal((await downloads.save("s1", URL_A, "x.pdf", 0)).bytes, BYTES.length);
  });

  it("refuses with a write failure when Firefox rejects the save for another reason", async () => {
    const { fake, downloads, revoked } = await setup();
    fake.failNextDownload(new Error("An unexpected error occurred"));
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), WRITE_FAILED);
    fake.failNextDownload("filename must not be absolute");
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), WRITE_FAILED);
    assert.equal(revoked.length, 2);
  });

  it("refuses a download Firefox interrupts", async () => {
    const { fake, downloads, revoked } = await setup();
    fake.downloadState = "interrupted";
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), WRITE_FAILED);
    assert.equal(revoked.length, 1);
    assert.equal(fake.downloadListenerCount(), 0);
  });

  it("finishes when Firefox reports the end before the download's id", async () => {
    const { fake, downloads } = await setup();
    fake.downloadTiming = "event_before_id";
    assert.equal((await downloads.save("s1", URL_A, "x.pdf", 0)).bytes, BYTES.length);
    fake.downloadState = "interrupted";
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), WRITE_FAILED);
  });

  it("waits for the download's own end, ignoring other downloads and other changes", async () => {
    const { fake, downloads } = await setup();
    fake.downloadTiming = "held";
    const saving = track(downloads.save("s1", URL_A, "x.pdf", 0));
    await until(() => fake.downloadCalls.length === 1);
    await flush();
    fake.finishDownload(99, "complete");
    fake.emitDownloadChanged({ id: 1, state: { current: "in_progress" } });
    fake.emitDownloadChanged({ id: 1 });
    await flush();
    assert.equal(saving.settled, false);
    fake.finishDownload(1, "complete");
    assert.deepEqual(await saving.promise, {
      path: `${FAKE_DOWNLOAD_FOLDER}/x.pdf`,
      bytes: BYTES.length,
    });
  });

  it("refuses a held download that Firefox then interrupts", async () => {
    const { fake, downloads } = await setup();
    fake.downloadTiming = "held";
    const saving = downloads.save("s1", URL_A, "x.pdf", 0);
    await until(() => fake.downloadCalls.length === 1);
    await flush();
    fake.finishDownload(1, "interrupted");
    await assert.rejects(saving, WRITE_FAILED);
  });

  it("refuses a finished download Firefox no longer lists", async () => {
    const { fake, downloads } = await setup();
    fake.downloadTiming = "held";
    const saving = downloads.save("s1", URL_A, "x.pdf", 0);
    await until(() => fake.downloadCalls.length === 1);
    await flush();
    fake.downloads.delete(1);
    fake.finishDownload(1, "complete");
    await assert.rejects(saving, WRITE_FAILED);
  });

  it("times out a fetch that does not answer, and aborts it", async () => {
    const { fake, downloads, fetchCalls, respondWith, timers } = await setup();
    respondWith((init) => never(init.signal));
    const saving = downloads.save("s1", URL_A, "x.pdf", 0);
    await until(() => fetchCalls.length === 1);
    timers.advance(DOWNLOAD_TIMEOUT_MS - 1);
    await flush();
    assert.equal(fetchCalls[0]?.init.signal.aborted, false);
    timers.advance(1);
    await assert.rejects(saving, TIMED_OUT);
    assert.equal(fetchCalls[0]?.init.signal.aborted, true);
    assert.deepEqual(fake.downloadCalls, []);
  });

  it("saves nothing after a timeout that came during the last site check", async () => {
    const { fake, downloads, holdView, views, timers } = await setup();
    const release = holdView(3);
    const saving = downloads.save("s1", URL_A, "x.pdf", 0);
    await until(() => views() === 3);
    timers.advance(DOWNLOAD_TIMEOUT_MS);
    await assert.rejects(saving, TIMED_OUT);
    release();
    for (let turn = 0; turn < 10; turn += 1) await flush();
    assert.deepEqual(fake.downloadCalls, []);
  });

  it("cancels a save that does not end within the timeout, and frees its bytes", async () => {
    const { fake, downloads, revoked, timers } = await setup();
    fake.downloadTiming = "held";
    const saving = downloads.save("s1", URL_A, "x.pdf", 0);
    await until(() => fake.downloadCalls.length === 1);
    await flush();
    timers.advance(DOWNLOAD_TIMEOUT_MS);
    await assert.rejects(saving, TIMED_OUT);
    await until(() => revoked.length === 1);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    assert.equal(fake.downloadListenerCount(), 0);
  });

  it("leaves no unhandled rejection when Firefox refuses to cancel a timed-out save", async () => {
    const { fake, downloads, revoked, timers } = await setup();
    fake.downloadTiming = "held";
    fake.failCancel(new Error("Download 1 cannot be canceled"));
    const saving = downloads.save("s1", URL_A, "x.pdf", 0);
    await until(() => fake.downloadCalls.length === 1);
    await flush();
    timers.advance(DOWNLOAD_TIMEOUT_MS);
    await assert.rejects(saving, TIMED_OUT);
    await until(() => revoked.length === 1);
    assert.deepEqual(fake.cancelledDownloads, [1]);
    assert.equal(fake.downloadListenerCount(), 0);
    // The cancel did reject.
    await assert.rejects(fake.browser.downloads.cancel(1), /cannot be canceled/);
  });

  it("listens to requests that belong to no tab, blocking, only while a download runs", async () => {
    const { fake, downloads, fetchCalls, respondWith, holdView, views, timers, missFirstRequest } =
      await setup();
    const listening = [
      {
        event: "onBeforeRequest",
        filter: { urls: ["<all_urls>"], tabId: -1 },
        extraInfoSpec: ["blocking"],
      },
    ];
    let atFetch: unknown[] = [];
    respondWith(() => {
      atFetch = fake.activeWebRequestRegistrations();
      return response(URL_A, BYTES);
    });
    await downloads.save("s1", URL_A, "x.pdf", 0);
    assert.deepEqual(atFetch, listening);
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
    await assert.rejects(downloads.save("s1", `${UNAPPROVED}/x`, "x.pdf", 0));
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
    respondWith(async (_init, redirect) => {
      await redirect(`${UNAPPROVED}/x`);
      return response(`${UNAPPROVED}/x`, BYTES);
    });
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0));
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
    // A timeout during the first site check.
    const before = views();
    const release = holdView(before + 1);
    const saving = downloads.save("s1", URL_A, "x.pdf", 0);
    await until(() => views() === before + 1);
    timers.advance(DOWNLOAD_TIMEOUT_MS);
    await assert.rejects(saving, TIMED_OUT);
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
    release();
    for (let turn = 0; turn < 10; turn += 1) await flush();
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
    assert.equal(timers.pending(), 0);
    // A timeout before the listener saw any of the fetch's requests.
    missFirstRequest();
    respondWith((init) => never(init.signal));
    const fetched = fetchCalls.length;
    const unseen = downloads.save("s1", URL_A, "x.pdf", 0);
    await until(() => fetchCalls.length === fetched + 1);
    timers.advance(DOWNLOAD_TIMEOUT_MS);
    await assert.rejects(unseen, TIMED_OUT);
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
  });

  it("cancels a hop whose judgement was still pending when the download timed out", async () => {
    const { fake, downloads, background, fetchCalls, respondWith, holdView, timers } =
      await setup();
    const release = holdView(2);
    respondWith((init) => never(init.signal));
    const saving = downloads.save("s1", URL_A, "x.pdf", 0);
    await until(() => fetchCalls.length === 1);
    const [answer] = fake.emitWebRequest("onBeforeRequest", request(`${OTHER}/x`, "1", background));
    timers.advance(DOWNLOAD_TIMEOUT_MS);
    await assert.rejects(saving, TIMED_OUT);
    release();
    assert.deepEqual(await answer, { cancel: true });
  });

  it("keeps cancelling a timed-out fetch's requests for a while, and only those", async () => {
    const {
      fake,
      downloads,
      background,
      fetchCalls,
      requests,
      respondWith,
      timers,
      missFirstRequest,
    } = await setup();
    respondWith((init) => never(init.signal));
    const saving = downloads.save("s1", URL_A, "x.pdf", 0);
    await until(() => fetchCalls.length === 1);
    timers.advance(DOWNLOAD_TIMEOUT_MS);
    await assert.rejects(saving, TIMED_OUT);
    assert.equal(fake.activeWebRequestRegistrations().length, 1);
    assert.deepEqual(
      fake.emitWebRequest("onBeforeRequest", request(`${OTHER}/x`, "1", background)),
      [{ cancel: true }],
    );
    assert.deepEqual(
      fake.emitWebRequest("onBeforeRequest", request(`${OTHER}/x`, "9", background)),
      [undefined],
    );
    // The next download is judged by its own listener alone, and never takes the timed-out
    // fetch's request, which reaches it first, for its own.
    missFirstRequest();
    let lateAnswers: unknown[] = [];
    respondWith(async (_init, redirect) => {
      lateAnswers = fake.emitWebRequest(
        "onBeforeRequest",
        request(`${OTHER}/next`, "1", background),
      );
      await redirect(`${UNAPPROVED}/x`);
      return response(`${UNAPPROVED}/x`, BYTES);
    });
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), {
      code: "site_not_approved",
      message: `The link led to ${UNAPPROVED}, which Foxleash is not allowed on in this session; nothing was requested there and nothing was saved.`,
    });
    assert.deepEqual(lateAnswers, [{ cancel: true }, undefined]);
    const answers = requests.at(-1)?.answers ?? [];
    assert.equal(answers.length, 2);
    assert.equal(answers[0], undefined);
    assert.deepEqual(await answers[1], { cancel: true });
    respondWith(async (_init, redirect) => {
      await redirect(`${OTHER}/x`);
      return response(`${OTHER}/x`, BYTES);
    });
    assert.equal((await downloads.save("s1", URL_A, "x.pdf", 0)).bytes, BYTES.length);
    assert.equal(fake.activeWebRequestRegistrations().length, 1);
    timers.advance(LATE_HOP_MS - 1);
    assert.equal(fake.activeWebRequestRegistrations().length, 1);
    timers.advance(1);
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
  });

  it("refuses to download without access to all websites, before any request", async () => {
    const { fake, downloads, fetchCalls } = await setup();
    const refusal = {
      code: "download_failed",
      message:
        'Foxleash needs access to all websites to download a file. Ask the user to open about:addons in Firefox, click Foxleash, then the Permissions tab, and under "Optional" turn on "Access your data for all websites". Nothing was saved.',
    };
    fake.allUrls = false;
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), refusal);
    const contains = fake.browser.permissions.contains;
    fake.allUrls = true;
    fake.browser.permissions.contains = () => Promise.reject(new Error("no answer"));
    await assert.rejects(downloads.save("s1", URL_A, "x.pdf", 0), refusal);
    assert.deepEqual(fetchCalls, []);
    assert.deepEqual(fake.activeWebRequestRegistrations(), []);
    fake.browser.permissions.contains = contains;
    assert.equal((await downloads.save("s1", URL_A, "x.pdf", 0)).bytes, BYTES.length);
  });

  it("refuses a second download while one is in progress, and takes one after it ends", async () => {
    const { fake, downloads, fetchCalls } = await setup();
    fake.downloadTiming = "held";
    const first = downloads.save("s1", URL_A, "x.pdf", 0);
    await assert.rejects(downloads.save("s2", URL_A, "y.pdf", 0), {
      code: "download_busy",
      message: "Foxleash is already saving a file; try again when it has finished.",
    });
    await until(() => fake.downloadCalls.length === 1);
    assert.equal(fetchCalls.length, 1);
    await flush();
    fake.finishDownload(1, "complete");
    await first;
    const second = downloads.save("s1", URL_A, "y.pdf", 0);
    await until(() => fake.downloadCalls.length === 2);
    await flush();
    fake.finishDownload(2, "interrupted");
    await assert.rejects(second, WRITE_FAILED);
    fake.downloadTiming = "immediate";
    assert.equal((await downloads.save("s1", URL_A, "z.pdf", 0)).bytes, BYTES.length);
  });

  it("takes a download after one that was refused", async () => {
    const { downloads } = await setup();
    await assert.rejects(downloads.save("s1", `${UNAPPROVED}/x`, "x.pdf", 0), {
      code: "site_not_approved",
    });
    assert.equal((await downloads.save("s1", URL_A, "x.pdf", 0)).bytes, BYTES.length);
  });
});

describe("downloadNameProblem", () => {
  it("accepts a plain file name of at most 200 bytes in UTF-8", () => {
    const ascii = `${"a".repeat(MAX_DOWNLOAD_NAME_BYTES - 4)}.pdf`;
    const twoByte = "é".repeat(MAX_DOWNLOAD_NAME_BYTES / 2);
    for (const name of ["receipt.pdf", "noext", "Receipt 1234 (May).pdf", ascii, twoByte]) {
      assert.equal(downloadNameProblem(name), undefined, name);
    }
  });

  it("refuses anything else", () => {
    const names: unknown[] = [
      undefined,
      1,
      null,
      ["x.pdf"],
      "",
      `${"a".repeat(MAX_DOWNLOAD_NAME_BYTES - 3)}.pdf`,
      "é".repeat(MAX_DOWNLOAD_NAME_BYTES / 2 + 1),
      "a/b.pdf",
      "a\\b.pdf",
      ".x.pdf",
      "a\u0000.pdf",
      "a\u001f.pdf",
      "a\u007f.pdf",
      "receipt\u202Efdp.sh",
      "a\u200Bb.pdf",
    ];
    for (const name of names) {
      assert.equal(
        downloadNameProblem(name),
        "download needs filename to be a plain file name such as receipt.pdf: at most 200 bytes in UTF-8, no slash or backslash, no control or formatting characters, not starting with a dot.",
        JSON.stringify(name),
      );
    }
  });
});

interface FetchInit {
  credentials: "include";
  cache: "no-store";
  signal: AbortSignal;
}

async function setup() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({ browser: fake.browser, groups, sessions, timers });
  await grantSite(fake.browser, SITE);
  await grantSite(fake.browser, OTHER);
  const fetchCalls: { url: string; init: FetchInit }[] = [];
  let respond: Answer = () => response(URL_A, BYTES);
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  const holds = new Map<number, Promise<void>>();
  const failures = new Map<number, unknown>();
  let viewCount = 0;
  const background = fake.browser.runtime.getURL("_generated_background_page.html");
  // What each listener answered for each request the fake fetch sent, as returned.
  const requests: { url: string; requestId: string; answers: unknown[] }[] = [];
  let missFirst = false;
  const downloads = createDownloads({
    browser: fake.browser,
    access: {
      view: async (session: string): Promise<SiteView> => {
        viewCount += 1;
        await holds.get(viewCount);
        if (failures.has(viewCount)) throw failures.get(viewCount);
        return access.view(session);
      },
      generation: (session: string) => access.generation(session),
    },
    timers,
    // As Firefox does: the first request and each redirect hop reach the listeners first, with
    // one request id, and a cancelled one rejects the fetch.
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      const requestId = String(fetchCalls.length);
      if (!missFirst) await send(url, requestId);
      return respond(init, (hop) => send(hop, requestId));
    },
    objectUrls: {
      create: (blob) => {
        const url = `blob:moz-extension://fake/${blobs.size + 1}`;
        blobs.set(url, blob);
        return url;
      },
      revoke: (url) => {
        revoked.push(url);
      },
    },
  });

  /** Sends a request of the fetch past the listeners; rejects as Firefox's fetch when cancelled. */
  async function send(url: string, requestId: string): Promise<void> {
    const answers = fake.emitWebRequest("onBeforeRequest", request(url, requestId, background));
    requests.push({ url, requestId, answers });
    const settled = await Promise.all(answers);
    if (settled.some((answer) => isDeepStrictEqual(answer, { cancel: true }))) {
      throw new TypeError("NetworkError when attempting to fetch resource.");
    }
  }

  /** What the fetch answers from now on, after any hops it asks for with `redirect`. */
  function respondWith(answer: Answer): void {
    respond = answer;
  }

  /** Holds the `nth` site check, counted from 1, until the returned release runs. */
  function holdView(nth: number): () => void {
    const { promise, resolve } = Promise.withResolvers<void>();
    holds.set(nth, promise);
    return () => resolve();
  }

  /** Makes the `nth` site check, counted from 1, reject with `error`. */
  function failView(nth: number, error: unknown): void {
    failures.set(nth, error);
  }

  /** From now on, the fetch's first request reaches no listener. */
  function missFirstRequest(): void {
    missFirst = true;
  }

  return {
    fake,
    timers,
    sessions,
    access,
    downloads,
    fetchCalls,
    blobs,
    revoked,
    background,
    requests,
    respondWith,
    holdView,
    failView,
    missFirstRequest,
    views: () => viewCount,
  };
}

/** A fetch's answer; `redirect` sends a hop first, and rejects when it was cancelled. */
type Answer = (
  init: FetchInit,
  redirect: (url: string) => Promise<void>,
) => Response | Promise<Response>;

/** A request that belongs to no tab, unless `tabId` says otherwise. */
function request(url: string, requestId: string, originUrl: string, tabId = -1): RequestDetails {
  return {
    requestId,
    tabId,
    timeStamp: 0,
    frameId: 0,
    url,
    method: "GET",
    type: "xmlhttprequest",
    originUrl,
    documentUrl: originUrl,
  };
}

/** A response from `url`; `fetch` sets a response's URL, the constructor cannot. */
function response(url: string, body: BodyInit | null, init: ResponseInit = {}): Response {
  const made = new Response(body, init);
  Object.defineProperty(made, "url", { value: url });
  return made;
}

/** A body that hands out `chunks` one read at a time, calling `onPull` before each. */
function stream(
  chunks: Uint8Array[],
  onPull: (index: number) => Promise<void> | void = () => {},
): { body: ReadableStream<Uint8Array>; pulled(): number } {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const index = pulled;
        pulled += 1;
        await onPull(index);
        const chunk = chunks[index];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    },
    // Nothing is read before the consumer asks.
    { highWaterMark: 0 },
  );
  return { body, pulled: () => pulled };
}

/** A fetch that never answers, and rejects once aborted, as Firefox's does. */
function never(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: boolean } {
  const tracked = { promise, settled: false };
  promise.then(
    () => {
      tracked.settled = true;
    },
    () => {
      tracked.settled = true;
    },
  );
  return tracked;
}

async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (condition()) return;
    await flush();
  }
  assert.fail("the condition never held");
}
