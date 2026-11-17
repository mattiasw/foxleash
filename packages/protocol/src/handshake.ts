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

/** A part's version and protocol, and the oldest protocol it works with when that is older. */
export function versionsOf(part: PartInfo): string {
  const versions = `version ${part.version}, protocol ${part.protocol}`;
  if (part.oldest === undefined || part.oldest >= part.protocol) return versions;
  return `${versions}, which works with protocol ${part.oldest} and later`;
}

/** The command that updates Foxleash installed from a checkout, the program and the add-on. */
export const UPDATE_COMMAND = "git pull && npm ci && npm run setup";

/** The command that installs the add-on matching the program. */
export const EXTENSION_UPDATE_COMMAND = "npm run setup";

const UPDATE = `update Foxleash with \`${UPDATE_COMMAND}\` if you have not yet`;

const NAME: Record<Part, string> = {
  extension: "Foxleash extension",
  host: "Foxleash native host",
  mcp: "Foxleash MCP server",
};

const FIX: Record<Part, string> = {
  extension: `run \`${EXTENSION_UPDATE_COMMAND}\` in your Foxleash folder and confirm the extension update in Firefox`,
  host: `Firefox is still running the old native host, so ${UPDATE} and then restart Firefox`,
  mcp: `your MCP client is still running the old MCP server, so ${UPDATE} and then restart your MCP client`,
};
