export type Part = "extension" | "host" | "mcp";

export interface PartInfo {
  part: Part;
  protocol: number;
  version: string;
}

/** Returns null when both parts speak the same protocol, otherwise a sentence naming the stale one. */
export function protocolMismatch(a: PartInfo, b: PartInfo): string | null {
  if (a.protocol === b.protocol) return null;
  const [stale, other] = a.protocol < b.protocol ? [a, b] : [b, a];
  return (
    `The ${NAME[stale.part]} (version ${stale.version}, protocol ${stale.protocol}) ` +
    `is older than the ${NAME[other.part]} (version ${other.version}, protocol ${other.protocol}): ` +
    `${FIX[stale.part]}.`
  );
}

const UPDATE = "update Foxhand with `git pull && npm ci && npm run setup` if you have not yet";

const NAME: Record<Part, string> = {
  extension: "Foxhand extension",
  host: "Foxhand native host",
  mcp: "Foxhand MCP server",
};

const FIX: Record<Part, string> = {
  extension:
    "run `npm run setup` in your Foxhand folder and confirm the extension update in Firefox",
  host: `Firefox is still running the old native host, so ${UPDATE} and then restart Firefox`,
  mcp: `your MCP client is still running the old MCP server, so ${UPDATE} and then restart your MCP client`,
};
