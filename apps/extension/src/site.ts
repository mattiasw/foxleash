/**
 * The site of an http(s) URL: its scheme, host and port, with one trailing dot stripped from the
 * host. Undefined for any other scheme, an unparseable URL or a host that is not canonical.
 */
export function siteOf(url: string): string | undefined {
  const parsed = URL.parse(url);
  return parsed === null ? undefined : siteOfParsed(parsed);
}

/** What an unapproved tab's URL reveals: its site, `about:blank`, or only its scheme. */
export function redactedUrl(url: string | undefined): string {
  if (url === undefined) return "";
  const parsed = URL.parse(url);
  if (parsed === null) return "";
  if (isWeb(parsed)) return siteOfParsed(parsed) ?? parsed.protocol;
  if (url === "about:blank") return url;
  return parsed.protocol;
}

function siteOfParsed(parsed: URL): string | undefined {
  if (!isWeb(parsed)) return undefined;
  const { hostname, port, protocol } = parsed;
  const host = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  // "http://./" has the host "."; a second trailing dot would make a site that never matches.
  if (host === "" || host.endsWith(".")) return undefined;
  return `${protocol}//${host}${port === "" ? "" : `:${port}`}`;
}

function isWeb(parsed: URL): boolean {
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}
