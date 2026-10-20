/** A request from the background to the content script in a tab's top frame. */
export interface PageRequest {
  kind: typeof PAGE_REQUEST_KIND;
  type: string;
  /** The site the background checked, as `siteOf` returns it. */
  site: string;
  params: Record<string, unknown>;
}

/** The content script's reply, with the site of the document that answered. */
export type PageReply =
  | { ok: true; site: string; result: unknown }
  | { ok: false; site: string; code: string; message: string };

/** The content script's requests by type; a handler may return a promise. */
export type PageHandlers = Record<string, (params: Record<string, unknown>) => unknown>;

export const PAGE_REQUEST_KIND = "foxhand-page";

/** The codes the background passes through from a content script's error reply. */
export const PAGE_ERROR_CODES: readonly string[] = [
  "invalid_params",
  "invalid_ref",
  "stale_ref",
  "ref_not_found",
  "page_changed",
  "invalid_target",
  "element_covered",
  "element_not_visible",
  "no_element_at_point",
  "in_frame",
  "cross_site_navigation",
];

/** The background's cap on the length of a reply as JSON. */
export const MAX_PAGE_REPLY_CHARS = 2_000_000;

/** A failure a page handler reports: `code` is one of `PAGE_ERROR_CODES`, `message` one plain sentence. */
export class PageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The value of an own property, else undefined: nothing is read through the prototype. */
export function ownField(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

/**
 * The content script's answer to a message: undefined, synchronously, for anything that is not
 * a Foxhand page request, so Firefox sends no reply; else a reply promise that never rejects.
 */
export function handlePageMessage(
  message: unknown,
  ctx: { site: string | undefined; handlers: PageHandlers },
): Promise<PageReply> | undefined {
  if (!isRecord(message) || ownField(message, "kind") !== PAGE_REQUEST_KIND) return undefined;
  const site = ctx.site ?? "";
  const type = ownField(message, "type");
  const requestSite = ownField(message, "site");
  const params = ownField(message, "params");
  if (typeof type !== "string" || typeof requestSite !== "string" || !isRecord(params)) {
    return Promise.resolve(
      failure(site, "invalid_params", "Foxhand's page script got a request it cannot read."),
    );
  }
  if (ctx.site !== requestSite) {
    return Promise.resolve(
      failure(site, "page_changed", "The page changed while Foxhand was working in it; try again."),
    );
  }
  const handler = Object.hasOwn(ctx.handlers, type) ? ctx.handlers[type] : undefined;
  if (handler === undefined) {
    return Promise.resolve(
      failure(site, "invalid_params", "Foxhand's page script has no request of that type."),
    );
  }
  return run(handler, params, site);
}

/**
 * Cuts text to at most `max` UTF-16 units without splitting a surrogate pair. `total` is the
 * original length, for the caller's truncation note.
 */
export function capText(
  text: string,
  max: number,
): { text: string; truncated: boolean; total: number } {
  const total = text.length;
  if (total <= max) return { text, truncated: false, total };
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut, truncated: true, total };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(site: string, code: string, message: string): PageReply {
  return { ok: false, site, code, message };
}

async function run(
  handler: (params: Record<string, unknown>) => unknown,
  params: Record<string, unknown>,
  site: string,
): Promise<PageReply> {
  try {
    const result: unknown = await handler(params);
    return { ok: true, site, result };
  } catch (error: unknown) {
    if (error instanceof PageError) return failure(site, error.code, error.message);
    return failure(site, "page_error", "The request failed in the page.");
  }
}
