import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BuildOptions, build as bundle } from "esbuild";

const root = import.meta.dirname;
export const dist = join(root, "dist");

export const esbuildOptions: BuildOptions = {
  entryPoints: [join(root, "src", "background.ts")],
  outfile: join(dist, "background.js"),
  bundle: true,
  format: "iife",
  // Mozilla's reviewers read the output.
  minify: false,
  target: "firefox140",
};

/** Writes the extension into `dist/`, starting from an empty folder. */
export async function build(): Promise<void> {
  await prepareDist();
  await bundle(esbuildOptions);
}

/** Empties `dist/` and writes everything except the bundle: the manifest and the icons. */
export async function prepareDist(): Promise<void> {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  const manifest = await readJsonObject("manifest.json");
  const { version } = await readJsonObject("package.json");
  if (typeof version !== "string") throw new Error("package.json has no version string.");
  await writeFile(
    join(dist, "manifest.json"),
    `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
  );
  await cp(join(root, "icons"), join(dist, "icons"), { recursive: true });
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(join(root, file), "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file} is not a JSON object.`);
  }
  return { ...value };
}

if (import.meta.main) await build();
