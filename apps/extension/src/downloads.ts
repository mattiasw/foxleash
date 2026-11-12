import { DOWNLOAD_MAX_BYTES } from "@foxleash/protocol";
import type { BrowserApi, DownloadDelta, Timers } from "./browser-api.ts";
import { ToolError } from "./handlers.ts";
import { siteOf } from "./site.ts";
import { type SiteAccess, siteBlocked } from "./site-access.ts";

/** Saves files from approved sites into Firefox's download folder (ADR 0019). */
export interface Downloads {
  /** `url` is a canonical http(s) href and `filename` a name `downloadNameProblem` accepts. */
  save(session: string, url: string, filename: string): Promise<{ path: string; bytes: number }>;
}

export interface DownloadsDeps<Handle> {
  browser: Pick<BrowserApi, "downloads">;
  access: Pick<SiteAccess, "view">;
  timers: Timers<Handle>;
  fetch: (
    url: string,
    init: { credentials: "include"; cache: "no-store"; signal: AbortSignal },
  ) => Promise<Response>;
  objectUrls: { create(blob: Blob): string; revoke(url: string): void };
}

/** Bounds a whole download, below the host's 60 s request timeout. */
export const DOWNLOAD_TIMEOUT_MS = 50_000;
/** File systems cap a name at 255 bytes; this leaves room for the number Firefox adds. */
export const MAX_DOWNLOAD_NAME_BYTES = 200;

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
  return { save };

  async function save(
    session: string,
    url: string,
    filename: string,
  ): Promise<{ path: string; bytes: number }> {
    if (busy) {
      throw new ToolError(
        "download_busy",
        "Foxleash is already saving a file; try again when it has finished.",
      );
    }
    busy = true;
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
      return await Promise.race([
        fetchAndSave(session, url, filename, controller.signal),
        timedOut,
      ]);
    } finally {
      timers.clearTimeout(timer);
      // Stops a fetch or body still arriving after a refusal or the timeout, and a save in progress.
      controller.abort();
      busy = false;
    }
  }

  async function fetchAndSave(
    session: string,
    url: string,
    filename: string,
    signal: AbortSignal,
  ): Promise<{ path: string; bytes: number }> {
    await downloadGate(session, url, notApproved);
    let response: Response;
    try {
      response = await fetch(url, { credentials: "include", cache: "no-store", signal });
    } catch {
      throw fetchFailed();
    }
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
    const path = await saveFile(blob, filename, signal);
    return { path, bytes };
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
