import pkg from "../package.json" with { type: "json" };

// Same as the protocol package's release-version pattern.
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

export const SERVER_VERSION = parseVersion(pkg);

export function parseVersion(value: unknown): string {
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
