// Hides, as a best effort, credential-like values in a request address: the values of
// parameters named like credentials, of parameters whose value holds such a parameter, and every
// JWT-shaped string after the authority. Works on the string itself: parsing and serializing it
// with URL would re-encode and normalize the bytes that stay.
import { capText } from "./page-messages.ts";
import { JWT, REDACTED } from "./response-body.ts";

/** Normalized parameter names that are a credential as a whole. */
const CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
  "auth",
  "authcode",
  "authorization",
  "code",
  "jwt",
  "logincode",
  "oobcode",
  "otp",
  "pass",
  "passcode",
  "pw",
  "pwd",
  "session",
  "sid",
  "sig",
  "ticket",
]);
/** A normalized name ending in one of these is a credential's: api_key, X-Amz-Signature, PHPSESSID. */
const CREDENTIAL_ENDINGS: readonly string[] = [
  "key",
  "signature",
  "sessionid",
  "sessid",
  "verifier",
];
/** A normalized name containing one of these is a credential's: reset_password_token, token_hash. */
const CREDENTIAL_WORDS: readonly string[] = ["token", "password", "passwd", "secret", "credential"];
/** OAuth's token_type and token_type_hint: standard parameters whose value is never secret. */
const NOT_CREDENTIALS: ReadonlySet<string> = new Set(["tokentype", "tokentypehint"]);
/**
 * Callers keep a few thousand characters at most; the cut bounds the scan's cost, since a page
 * can send addresses of up to a million characters.
 */
export const MAX_SCANNED_URL = 16_384;
/** Anchored, and ends at `\` too: a raw Location header value may use it for `/`. */
const SCHEME_AND_AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\\]*/;
const PATH_PARAMETER = /;([^;/=]*)=([^;/]*)/g;
const NAME_SEGMENTS = /[?#/;]/;
const NAME_PIECES = /[[\]]/;
const NESTED_PIECES = /[?&#;]/;
const ESCAPE = /%([0-9A-Fa-f]{2})/g;
const LINK_TARGET = /<([^>]*)/g;
const QUOTED = /"([^"]*)"/g;
const NOT_NAME_CHARACTER = /[^a-z0-9]/g;
const DIGITS = "0123456789";
const MAX_DECODES = 3;

/** The address with credential-like values replaced; the first `MAX_SCANNED_URL` characters only. */
export function redactUrlCredentials(url: string): string {
  const text = capText(url, MAX_SCANNED_URL).text;
  // The scheme and authority stay as they are, so the site decided on the address is unchanged
  // and a `[` never lands in the host. The user-info is not redacted.
  const authority = SCHEME_AND_AUTHORITY.exec(text)?.[0] ?? "";
  const rest = text.slice(authority.length);
  const hash = rest.indexOf("#");
  const beforeHash = hash === -1 ? rest : rest.slice(0, hash);
  const question = beforeHash.indexOf("?");
  const path = question === -1 ? beforeHash : beforeHash.slice(0, question);
  let redacted = path.replace(PATH_PARAMETER, redactPathParameter);
  if (question !== -1) redacted += `?${redactParameters(beforeHash.slice(question + 1))}`;
  if (hash !== -1) redacted += `#${redactParameters(rest.slice(hash + 1))}`;
  return authority + redacted.replace(JWT, REDACTED);
}

/**
 * A Link header value with each `<...>` target, and each quoted parameter value such as an
 * `anchor` or `imagesrcset` address, redacted on its own.
 */
export function redactLinkCredentials(value: string): string {
  return capText(value, MAX_SCANNED_URL)
    .text.replace(LINK_TARGET, (_match, target: string) => `<${redactUrlCredentials(target)}`)
    .replace(QUOTED, (_match, quoted: string) => `"${redactUrlCredentials(quoted)}"`);
}

function redactPathParameter(match: string, name: string, value: string): string {
  return value !== "" && (isCredentialName(name) || holdsCredential(value))
    ? `;${name}=${REDACTED}`
    : match;
}

function redactParameters(text: string): string {
  return text.split("&").map(redactParameter).join("&");
}

function redactParameter(part: string): string {
  const equals = part.indexOf("=");
  const name = equals === -1 ? part : part.slice(0, equals);
  // A part with no name, or a name, can be an encoded address that holds a credential.
  if (holdsCredential(name)) return REDACTED;
  const value = equals === -1 ? "" : part.slice(equals + 1);
  if (value === "") return part;
  return isCredentialName(name) || holdsCredential(value) ? `${name}=${REDACTED}` : part;
}

/** Whether the value, as it is or percent-decoded up to `MAX_DECODES` times, holds a credential pair. */
function holdsCredential(value: string): boolean {
  let text = value;
  for (let decodes = 0; ; decodes += 1) {
    if (text.split(NESTED_PIECES).some(isCredentialPair)) return true;
    if (decodes === MAX_DECODES) return false;
    const decoded = decode(text);
    if (decoded === text) return false;
    text = decoded;
  }
}

function isCredentialPair(piece: string): boolean {
  const equals = piece.indexOf("=");
  return equals !== -1 && equals < piece.length - 1 && isCredentialName(piece.slice(0, equals));
}

function isCredentialName(name: string): boolean {
  const last = decode(name).split(NAME_SEGMENTS).at(-1) ?? "";
  return last.split(NAME_PIECES).some(isCredentialPiece);
}

function isCredentialPiece(piece: string): boolean {
  const word = piece.toLowerCase().replace(NOT_NAME_CHARACTER, "");
  const stem = withoutTrailingDigits(word);
  if (NOT_CREDENTIALS.has(stem)) return false;
  return (
    CREDENTIAL_NAMES.has(stem) ||
    CREDENTIAL_ENDINGS.some((ending) => stem.endsWith(ending)) ||
    CREDENTIAL_WORDS.some((credentialWord) => word.includes(credentialWord))
  );
}

/** A loop, not `/[0-9]+$/`, which rescans each run of digits from every position inside it. */
function withoutTrailingDigits(word: string): string {
  let end = word.length;
  while (end > 0 && DIGITS.includes(word.charAt(end - 1))) end -= 1;
  return word.slice(0, end);
}

/** Lenient percent-decoding: each `%XX` on its own, never throwing on an invalid sequence. */
function decode(text: string): string {
  return text
    .replaceAll("+", " ")
    .replace(ESCAPE, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}
