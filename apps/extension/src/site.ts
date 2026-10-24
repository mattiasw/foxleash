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

/** The URL without its fragment. */
export function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

/**
 * The host of a site, as the blocklist matches it. An IPv4-mapped IPv6 host becomes its IPv4
 * address.
 */
export function hostOf(site: string): string {
  const host = URL.parse(site)?.hostname ?? "";
  const mapped = IPV4_MAPPED.exec(host);
  if (mapped === null) return host;
  // Firefox connects to such an address over IPv4.
  const words = mapped.slice(1).map((group) => Number.parseInt(group, 16));
  return words.flatMap((word) => [word >> 8, word & 0xff]).join(".");
}

/** Whether a blocklist pattern covers the host: the domain itself or any of its subdomains. */
export function matchesDomain(host: string, pattern: string): boolean {
  return host === pattern || host.endsWith(`.${pattern}`);
}

/**
 * The blocklist the user typed, one domain per line: its patterns, or the lines that are not
 * domains, numbered from 1 with blank lines counted.
 */
export function parseBlocklist(
  text: string,
): { patterns: string[] } | { errors: { line: number; text: string }[] } {
  const patterns = new Set<string>();
  const errors: { line: number; text: string }[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    const result = normalizeDomain(line);
    if ("error" in result) errors.push({ line: index + 1, text: result.error });
    else patterns.add(result.host);
  });
  return errors.length > 0 ? { errors } : { patterns: [...patterns] };
}

/** One blocklist line as a pattern: a lowercase, punycoded domain, or why it is not one. */
export function normalizeDomain(line: string): { host: string } | { error: string } {
  let text = line.trim();
  if (text === "") return { error: EMPTY };
  // The URL parser deletes tabs and newlines anywhere in a host.
  if (/[\t\n\r]/.test(text)) return { error: NOT_A_DOMAIN };
  if (text.endsWith("/")) text = text.slice(0, -1);
  if (text.includes("*") || text.startsWith(".")) return { error: SUBDOMAINS };
  if (text.includes("://")) return { error: SCHEME };
  if (/[/\\?#]/.test(text)) return { error: PATH };
  // The parser decodes percent escapes in a host: "pay%2epal.com" would become "pay.pal.com".
  if (/[@%]/.test(text) || text.startsWith("[")) return { error: NOT_A_DOMAIN };
  // The parser drops a default port, so "paypal.com:80" would parse with no port.
  if (text.includes(":")) return { error: PORT };
  const parsed = URL.parse(`http://${text}/`);
  if (parsed === null) return { error: NOT_A_DOMAIN };
  const host = parsed.hostname.endsWith(".") ? parsed.hostname.slice(0, -1) : parsed.hostname;
  if (!HOSTNAME.test(host)) return { error: NOT_A_DOMAIN };
  // The parser reads "192.168" as 192.0.0.168 and "0x7f.1" as 127.0.0.1.
  if (/^[0-9.]+$/.test(host) && host !== text && `${host}.` !== text) {
    return { error: NOT_A_DOMAIN };
  }
  return { host };
}

const IPV4_MAPPED = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/;
const HOSTNAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

const EMPTY = "The line is empty.";
const NOT_A_DOMAIN = "This is not a domain; write one such as example.com.";
const SUBDOMAINS =
  "Write the domain without a wildcard or a leading dot: a domain already covers its subdomains.";
const SCHEME = "Write the domain without http:// or https://: it is blocked on both.";
const PATH = "Write the domain without a path, query or #: the whole site is blocked.";
const PORT = "Write the domain without a port: it is blocked on every port.";

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
