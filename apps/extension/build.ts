import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BuildOptions, build as bundle } from "esbuild";

const root = import.meta.dirname;
export const dist = join(root, "dist");

export const esbuildOptions: BuildOptions = {
  entryPoints: [
    join(root, "src", "background.ts"),
    join(root, "src", "options.ts"),
    join(root, "src", "approve.ts"),
    join(root, "src", "propose.ts"),
    join(root, "src", "content.ts"),
  ],
  outdir: dist,
  entryNames: "[name]",
  bundle: true,
  format: "iife",
  // Mozilla's reviewers read the output.
  minify: false,
  target: "firefox142",
};

/** Writes the extension into `dist/`, starting from an empty folder. */
export async function build(): Promise<void> {
  await prepareDist();
  await bundle(esbuildOptions);
}

/** Empties `dist/` and writes everything except the bundles: the manifest, the icons and the pages. */
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
  const pages = (await readdir(join(root, "src"))).filter((file) => /\.(html|css)$/.test(file));
  for (const page of pages) await copyFile(join(root, "src", page), join(dist, page));
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(join(root, file), "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file} is not a JSON object.`);
  }
  return { ...value };
}

if (import.meta.main) await build();
