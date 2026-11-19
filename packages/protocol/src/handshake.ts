export type Part = "extension" | "host" | "mcp";

export interface PartInfo {
  part: Part;
  protocol: number;
  version: string;
  /** The oldest protocol this part still works with; its `protocol` when absent. */
  oldest?: number;
}

/**
 * Returns null when the two parts work together: the part on the lower protocol is within the
 * other's window. Otherwise returns a sentence naming the stale one.
 */
export function protocolMismatch(a: PartInfo, b: PartInfo): string | null {
  if (a.protocol === b.protocol) return null;
  const [stale, other] = a.protocol < b.protocol ? [a, b] : [b, a];
  if (stale.protocol >= (other.oldest ?? other.protocol)) return null;
  return (
    `The ${NAME[stale.part]} (version ${stale.version}, protocol ${stale.protocol}) ` +
    `is older than the ${NAME[other.part]} (${versionsOf(other)}): ` +
    `${FIX[stale.part]}.`
  );
}

/**
 * Returns null when the two parts have the same version, or when `protocolMismatch` already names
 * them. Otherwise returns a sentence naming the older one and its fix. Information only: parts on
 * compatible protocols work together.
 */
export function versionDifference(a: PartInfo, b: PartInfo): string | null {
  if (a.version === b.version || protocolMismatch(a, b) !== null) return null;
  const order = compareVersions(a.version, b.version);
  if (order === undefined || order === 0) {
    return (
      `The ${NAME[a.part]} (version ${a.version}) and the ${NAME[b.part]} ` +
      `(version ${b.version}) differ in version: if the ${NAME[a.part]} is older, ` +
      `${FIX[a.part]}; if the ${NAME[b.part]} is older, ${FIX[b.part]}.`
    );
  }
  const [older, newer] = order < 0 ? [a, b] : [b, a];
  return (
    `The ${NAME[older.part]} (version ${older.version}) is older than the ` +
    `${NAME[newer.part]} (version ${newer.version}): ${FIX[older.part]}.`
  );
}

/**
 * Compares dot-separated versions of any length, a missing part counting as 0; negative when `a`
 * is lower, undefined when a part is not all digits.
 */
function compareVersions(a: string, b: string): number | undefined {
  const left = numericParts(a);
  const right = numericParts(b);
  if (left === undefined || right === undefined) return undefined;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0n) - (right[index] ?? 0n);
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }
  return 0;
}

function numericParts(version: string): bigint[] | undefined {
  const parts = version.split(".");
  if (!parts.every((part) => /^[0-9]+$/.test(part))) return undefined;
  return parts.map((part) => BigInt(part));
}

/** A part's version and protocol, and the oldest protocol it works with when that is older. */
export function versionsOf(part: PartInfo): string {
  const versions = `version ${part.version}, protocol ${part.protocol}`;
  if (part.oldest === undefined || part.oldest >= part.protocol) return versions;
  return `${versions}, which works with protocol ${part.oldest} and later`;
}

/** The command that updates the Foxleash program to the latest release. */
export const UPDATE_COMMAND = "npx foxleash@latest setup";

/** The add-on's page on Firefox Add-ons. */
export const ADDON_PAGE_URL = "https://addons.mozilla.org/firefox/addon/foxleash/";

const UPDATE = `update Foxleash with \`${UPDATE_COMMAND}\` if you have not yet`;

const NAME: Record<Part, string> = {
  extension: "Foxleash extension",
  host: "Foxleash native host",
  mcp: "Foxleash MCP server",
};

const FIX: Record<Part, string> = {
  extension: `update the add-on in Firefox (open about:addons and choose Check for Updates), or install it again from ${ADDON_PAGE_URL}`,
  host: `Firefox is still running the old native host, so ${UPDATE} and then restart Firefox`,
  mcp: `your MCP client is still running the old MCP server, so ${UPDATE} and then restart your MCP client`,
};
