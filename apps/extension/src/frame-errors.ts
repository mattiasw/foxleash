import type { BrowserApi, DocumentDetails, FrameDetails } from "./browser-api.ts";

/** The most frames showing an error page remembered per tab; the oldest is dropped first. */
export const MAX_ERROR_FRAMES = 100;
/** The longest failed URL remembered, so a page cannot fill the memory with long ones. */
export const MAX_FAILED_URL_LENGTH = 16_000;
/** The address Firefox gives the document of its error page. */
const ERROR_PAGE_PREFIX = "about:neterror?";

export interface FrameErrors {
  /**
   * Whether Firefox reported the frame's document, as the listing gives it, as its error page for
   * the URL the frame shows.
   */
  showsErrorPage(tabId: number, frame: FrameDetails): boolean;
}

interface ErrorPage {
  documentId: string;
  url: string;
}

/**
 * Remembers, per tab and subframe, the document Firefox last reported as its error page and the
 * URL that failed. Adds its listeners at once (call it at the top level of the background script).
 */
export function watchFrameErrors(browser: Pick<BrowserApi, "webNavigation" | "tabs">): FrameErrors {
  const tabs = new Map<number, Map<number, ErrorPage>>();

  browser.webNavigation.onDOMContentLoaded.addListener(record);
  browser.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));

  return { showsErrorPage };

  function record({ tabId, frameId, documentId, url }: DocumentDetails): void {
    if (frameId === 0 || typeof documentId !== "string" || !url.startsWith(ERROR_PAGE_PREFIX)) {
      return;
    }
    const failed = failedUrl(url);
    if (failed === undefined || failed === "" || failed.length > MAX_FAILED_URL_LENGTH) return;
    let frames = tabs.get(tabId);
    if (frames === undefined) {
      frames = new Map();
      tabs.set(tabId, frames);
    }
    // Map keeps insertion order: deleting first makes this frame the newest.
    frames.delete(frameId);
    frames.set(frameId, { documentId, url: failed });
    if (frames.size > MAX_ERROR_FRAMES) {
      const oldest = frames.keys().next();
      if (!oldest.done) frames.delete(oldest.value);
    }
  }

  function showsErrorPage(tabId: number, { frameId, documentId, url }: FrameDetails): boolean {
    const page = tabs.get(tabId)?.get(frameId);
    return page !== undefined && page.documentId === documentId && page.url === url;
  }
}

/**
 * The URL in the error page address's `u=` field. Not URLSearchParams: Firefox leaves `+`
 * unescaped there, which URLSearchParams reads as a space. It escapes `&`, so none is in the field.
 */
function failedUrl(errorPage: string): string | undefined {
  const field = errorPage
    .slice(ERROR_PAGE_PREFIX.length)
    .split("&")
    .find((part) => part.startsWith("u="));
  if (field === undefined) return undefined;
  try {
    return decodeURIComponent(field.slice("u=".length));
  } catch {
    return undefined;
  }
}
