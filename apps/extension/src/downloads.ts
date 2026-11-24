import { ALL_WEBSITES_ACCESS_STEPS, DOWNLOAD_MAX_BYTES } from "@foxleash/protocol";
import type { BrowserApi, Cancel, DownloadDelta, RequestDetails, Timers } from "./browser-api.ts";
import { refuseIfEnded, ToolError } from "./handlers.ts";
import { siteOf, withoutFragment } from "./site.ts";
import { type SiteAccess, siteBlocked } from "./site-access.ts";

/** Saves files from approved sites into Firefox's download folder (ADR 0019). */
export interface Downloads {
  /** `url` is a canonical http(s) href and `filename` a name `downloadNameProblem` accepts. */
  save(
    session: string,
    url: string,
    filename: string,
    generation: number,
  ): Promise<{ path: string; bytes: number }>;
}

export interface DownloadsDeps<Handle> {
  browser: Pick<BrowserApi, "downloads" | "webRequest" | "runtime" | "permissions">;
  access: Pick<SiteAccess, "view" | "generation">;
  timers: Timers<Handle>;
  fetch: (
    url: string,
    init: { credentials: "include"; cache: "no-store"; signal: AbortSignal },
  ) => Promise<Response>;
  objectUrls: { create(blob: Blob): string; revoke(url: string): void };
}

/** Bounds a whole download, below the host's 60 s request timeout. */
export const DOWNLOAD_TIMEOUT_MS = 50_000;
/**
 * How long a download that timed out during its fetch keeps cancelling that fetch's requests:
 * Firefox stops waiting for a response after 300 s by default (`network.http.response.timeout`).
 */
export const LATE_HOP_MS = 300_000;
/** File systems cap a name at 255 bytes; this leaves room for the number Firefox adds. */
export const MAX_DOWNLOAD_NAME_BYTES = 200;

/** One download's fetch, as its `onBeforeRequest` listener sees it (ADR 0099). */
interface Hops {
  session: string;
  /** The start URL without its fragment. */
  start: string;
  /** The fetch's: the first own request the listener saw while the fetch ran. */
  requestId?: string;
  /** The last address, without its fragment, the listener let a hop through to. */
  passed?: string;
  /** Why a hop was cancelled. */
  refusal?: ToolError;
  /** From just before `fetch` until it settles. */
  fetching: boolean;
  ended: boolean;
}

const BAD_NAME = `download needs filename to be a plain file name such as receipt.pdf: at most ${MAX_DOWNLOAD_NAME_BYTES} bytes in UTF-8, no slash or backslash, no control or formatting characters, not starting with a dot.`;

export function createDownloads<Handle>({
  browser,
  access,
  timers,
  fetch,
  objectUrls,
}: DownloadsDeps<Handle>): Downloads {
  // Each download holds its whole file in memory until Firefox has written it.
  let busy = false;
  // The fetches of downloads that timed out mid-fetch, whose listeners still cancel them.
  const lateRequests = new Set<string>();
  return { save };

  async function save(
    session: string,
    url: string,
    filename: string,
    generation: number,
  ): Promise<{ path: string; bytes: number }> {
    if (busy) {
      throw new ToolError(
        "download_busy",
        "Foxleash is already saving a file; try again when it has finished.",
      );
    }
    busy = true;
    const hops: Hops = { session, start: withoutFragment(url), fetching: false, ended: false };
    const listener = (details: RequestDetails) => onRequest(hops, details);
    const controller = new AbortController();
    const { promise: timedOut, reject } = Promise.withResolvers<never>();
    const timer = timers.setTimeout(() => {
      reject(
        new ToolError(
          "download_timeout",
          `The download did not finish within ${DOWNLOAD_TIMEOUT_MS / 1000} seconds.`,
        ),
      );
    }, DOWNLOAD_TIMEOUT_MS);
    try {
      browser.webRequest.onBeforeRequest.addListener(
        listener,
        { urls: ["<all_urls>"], tabId: -1 },
        ["blocking"],
      );
      return await Promise.race([
        fetchAndSave(session, url, filename, controller.signal, generation, hops),
        timedOut,
      ]);
    } finally {
      timers.clearTimeout(timer);
      const late = hops.fetching ? hops.requestId : undefined;
      hops.ended = true;
      // Stops a fetch or body still arriving after a refusal or the timeout, and a save in progress.
      controller.abort();
      const remove = () => browser.webRequest.onBeforeRequest.removeListener(listener);
      if (late === undefined) remove();
      else {
        lateRequests.add(late);
        timers.setTimeout(() => {
          lateRequests.delete(late);
          remove();
        }, LATE_HOP_MS);
      }
      busy = false;
    }
  }

  /** Judges the redirect hops of the download's own fetch; answers anything else at once. */
  function onRequest(
    hops: Hops,
    details: RequestDetails,
  ): Promise<Cancel | undefined> | Cancel | undefined {
    if (hops.ended) return details.requestId === hops.requestId ? { cancel: true } : undefined;
    if (hops.requestId === undefined) {
      if (
        !hops.fetching ||
        details.originUrl?.startsWith(browser.runtime.getURL("")) !== true ||
        lateRequests.has(details.requestId)
      ) {
        return undefined;
      }
      hops.requestId = details.requestId;
      // The start gate checked the first request.
      if (withoutFragment(details.url) === hops.start) return undefined;
    } else if (details.requestId !== hops.requestId) {
      return undefined;
    }
    return judgeHop(hops, details.url);
  }

  /** Never rejects. */
  async function judgeHop(hops: Hops, url: string): Promise<Cancel | undefined> {
    const refusal = await hopRefusal(hops.session, url);
    // An aborted fetch still sends a hop let through late (ADR 0099).
    if (hops.ended) return { cancel: true };
    if (refusal !== undefined) {
      hops.refusal = refusal;
      return { cancel: true };
    }
    hops.passed = withoutFragment(url);
    return undefined;
  }

  /** Why a hop to `url` may not be requested, from the session's view read anew. Never rejects. */
  async function hopRefusal(session: string, url: string): Promise<ToolError | undefined> {
    try {
      const site = siteOf(url);
      if (site === undefined) return fetchFailed();
      const view = await access.view(session);
      if (view.blocked(url)) return hopBlocked(site);
      if (!view.allowed(url)) return hopNotApproved(site);
      return undefined;
    } catch (error: unknown) {
      return error instanceof ToolError ? error : fetchFailed();
    }
  }

  async function fetchAndSave(
    session: string,
    url: string,
    filename: string,
    signal: AbortSignal,
    generation: number,
    hops: Hops,
  ): Promise<{ path: string; bytes: number }> {
    // Firefox fires webRequest events only for sites the add-on has host permission for.
    if (!(await mayReachAllSites())) throw noAccessToAllSites();
    await downloadGate(session, url, notApproved);
    refuseIfEnded(access, session, generation);
    let response: Response;
    hops.fetching = true;
    try {
      response = await fetch(url, { credentials: "include", cache: "no-store", signal });
    } catch {
      throw hops.refusal ?? fetchFailed();
    } finally {
      hops.fetching = false;
    }
    // An answer that came through a redirect the listener did not see was never judged.
    const final = withoutFragment(response.url);
    if (final !== hops.start && final !== hops.passed) throw fetchFailed();
    // Before the status or a byte of the body is read: a redirect may have left the site.
    await downloadGate(session, response.url, ledElsewhere);
    if (!response.ok) {
      throw new ToolError(
        "download_failed",
        `The server answered with status ${response.status}; nothing was saved.`,
      );
    }
    if (Number(response.headers.get("content-length")) > DOWNLOAD_MAX_BYTES) throw tooLarge();
    const { blob, bytes } = await readBody(response);
    // The user may have withdrawn the site while the body arrived.
    await downloadGate(session, response.url, ledElsewhere);
    // The call already answered with a timeout: a file saved now would only be left behind.
    if (signal.aborted) throw fetchFailed();
    refuseIfEnded(access, session, generation);
    const path = await saveFile(blob, filename, signal);
    return { path, bytes };
  }

  async function mayReachAllSites(): Promise<boolean> {
    try {
      return await browser.permissions.contains({ origins: ["<all_urls>"] });
    } catch {
      return false;
    }
  }

  /** Refuses a URL that is not on a site the session may already act on. Never asks. */
  async function downloadGate(
    session: string,
    url: string,
    refusal: (site: string) => ToolError,
  ): Promise<void> {
    const site = siteOf(url);
    if (site === undefined) throw fetchFailed();
    const view = await access.view(session);
    if (view.blocked(url)) throw siteBlocked(site);
    if (!view.allowed(url)) throw refusal(site);
  }

  /** Writes the bytes into the download folder and returns the file's absolute path. */
  async function saveFile(blob: Blob, filename: string, signal: AbortSignal): Promise<string> {
    const objectUrl = objectUrls.create(blob);
    const { promise: ended, resolve: end } = Promise.withResolvers<string>();
    // A download can finish before `download()` resolves with its id.
    const finished = new Map<number, string>();
    let id: number | undefined;
    const listener = (delta: DownloadDelta): void => {
      const state = delta.state?.current;
      if (state !== "complete" && state !== "interrupted") return;
      if (id === undefined) finished.set(delta.id, state);
      else if (delta.id === id) end(state);
    };
    const onAbort = (): void => end("aborted");
    browser.downloads.onChanged.addListener(listener);
    signal.addEventListener("abort", onAbort);
    try {
      try {
        id = await browser.downloads.download({
          url: objectUrl,
          filename,
          saveAs: false,
          conflictAction: "uniquify",
        });
      } catch (error: unknown) {
        throw refusedSave(error, filename);
      }
      const early = finished.get(id);
      if (early !== undefined) end(early);
      const [current] = await browser.downloads.search({ id });
      if (current?.state === "complete" || current?.state === "interrupted") end(current.state);
      const state = await ended;
      // The call has answered with its timeout already: this only stops the save, and a
      // rejection here reaches no one.
      if (state === "aborted") await browser.downloads.cancel(id);
      if (state !== "complete") throw writeFailed();
      const [item] = await browser.downloads.search({ id });
      if (item === undefined) throw writeFailed();
      return item.filename;
    } finally {
      browser.downloads.onChanged.removeListener(listener);
      objectUrls.revoke(objectUrl);
    }
  }
}

/** The bad-file-name refusal for a value that is not a plain file name, else undefined. */
export function downloadNameProblem(value: unknown): string | undefined {
  const plain =
    typeof value === "string" &&
    value !== "" &&
    new TextEncoder().encode(value).length <= MAX_DOWNLOAD_NAME_BYTES &&
    !/[/\\]/.test(value) &&
    !value.startsWith(".") &&
    // Control characters, and format characters such as U+202E, which can show "fdp.sh" as "hs.pdf".
    !/[\p{Cc}\p{Cf}]/u.test(value);
  return plain ? undefined : BAD_NAME;
}

/**
 * The body as a Blob without a type, and its size, refused as soon as it passes
 * DOWNLOAD_MAX_BYTES. The chunks go out of reach on return, so a save holds the bytes once.
 */
async function readBody(response: Response): Promise<{ blob: Blob; bytes: number }> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  if (response.body === null) return { blob: new Blob(chunks), bytes };
  const reader = response.body.getReader();
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array<ArrayBuffer>>;
    try {
      chunk = await reader.read();
    } catch {
      throw fetchFailed();
    }
    if (chunk.done) return { blob: new Blob(chunks), bytes };
    bytes += chunk.value.length;
    if (bytes > DOWNLOAD_MAX_BYTES) throw tooLarge();
    chunks.push(chunk.value);
  }
}

function notApproved(site: string): ToolError {
  return new ToolError(
    "site_not_approved",
    `Foxleash is not allowed on ${site} in this session; open it with tab_open or navigate first, which asks the user.`,
  );
}

function ledElsewhere(site: string): ToolError {
  return new ToolError(
    "site_not_approved",
    `The link led to ${site}, which Foxleash is not allowed on in this session; nothing was saved.`,
  );
}

function hopNotApproved(site: string): ToolError {
  return new ToolError(
    "site_not_approved",
    `The link led to ${site}, which Foxleash is not allowed on in this session; nothing was requested there and nothing was saved.`,
  );
}

function hopBlocked(site: string): ToolError {
  return new ToolError(
    "site_blocked",
    `The link led to ${site}, which is on Foxleash's blocklist; nothing was requested there and nothing was saved.`,
  );
}

function noAccessToAllSites(): ToolError {
  return new ToolError(
    "download_failed",
    `Foxleash needs access to all websites to download a file. Ask the user to ${ALL_WEBSITES_ACCESS_STEPS}. Nothing was saved.`,
  );
}

function fetchFailed(): ToolError {
  return new ToolError("download_failed", "Firefox could not fetch the file; nothing was saved.");
}

function tooLarge(): ToolError {
  return new ToolError(
    "download_too_large",
    `The file is larger than ${DOWNLOAD_MAX_BYTES / (1024 * 1024)} MiB; nothing was saved.`,
  );
}

function writeFailed(): ToolError {
  return new ToolError(
    "download_failed",
    "Firefox could not write the file to the download folder.",
  );
}

/** Firefox's own refusal, matched and never passed on: its text is not ours to show. */
function refusedSave(error: unknown, filename: string): ToolError {
  if (error instanceof Error && error.message.startsWith("filename must")) {
    return new ToolError(
      "invalid_params",
      `Firefox would not save a file named ${JSON.stringify(filename)}; choose a plain name with a usual extension, such as receipt.pdf.`,
    );
  }
  return writeFailed();
}
