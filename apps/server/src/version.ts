import { readFileSync } from "node:fs";

// Same as the protocol package's release-version pattern.
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

export const SERVER_VERSION = parseVersion(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export function parseVersion(text: string): string {
  const value: unknown = JSON.parse(text);
  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string" &&
    VERSION.test(value.version)
  ) {
    return value.version;
  }
  throw new Error("package.json has no valid version");
}
