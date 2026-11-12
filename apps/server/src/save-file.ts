import { open, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";

export type SaveResult = { ok: true; path: string } | { ok: false; message: string };

/**
 * Why `requested` cannot be saved in `folder`, from the path alone, or undefined when the path
 * passes these checks. `savePng` runs them again, then checks the file system.
 */
export function savePathProblem(folder: string, requested: string): string | undefined {
  if (requested === "") return "saveTo is empty; give a path ending in .png.";
  if (requested.includes("\0")) return "saveTo contains a NUL character; give a path without one.";
  if (!requested.toLowerCase().endsWith(".png")) {
    return `${requested} does not end in .png; give a path ending in .png.`;
  }
  const base = path.resolve(folder);
  const relative = path.relative(base, path.resolve(base, requested));
  if (relative === "" || !isInside(relative)) return outside(requested, base);
  return hasDotPart(relative) ? dotPart(requested) : undefined;
}

/**
 * Writes `png` as a new file at `requested` inside `folder`, mode 0600: never outside the
 * folder, also through a symlink, never into or through a name starting with a dot, never over
 * an existing file, and never creating a folder. A refusal is one sentence saying what to do.
 */
export async function savePng(
  folder: string,
  requested: string,
  png: Uint8Array,
): Promise<SaveResult> {
  const problem = savePathProblem(folder, requested);
  if (problem !== undefined) return refused(problem);
  const target = path.resolve(folder, requested);
  const parent = await realParent(folder, path.dirname(target), requested);
  if (!parent.ok) return parent;
  const file = path.join(parent.path, path.basename(target));
  // O_EXCL: never over an existing file, and never through a symlink at the name.
  const opened = await open(file, "wx", 0o600).then(
    (handle) => ({ handle }),
    (error: unknown) => ({ error }),
  );
  if ("error" in opened) {
    if (codeOf(opened.error) === "EEXIST") {
      return refused(`${requested} already exists; choose another name.`);
    }
    return refused(couldNotSave(requested));
  }
  const written = await opened.handle.writeFile(png).then(succeeded, failed);
  const closed = await opened.handle.close().then(succeeded, failed);
  if (!written || !closed) {
    // A part of a PNG left at the name would only block it.
    await unlink(file).catch(() => {});
    return refused(couldNotSave(requested));
  }
  return { ok: true, path: file };
}

/**
 * The real path of the folder to save in, once it is known to exist, to be a folder and to lie
 * in the real save folder with no part starting with a dot, so a symlink cannot lead out.
 */
async function realParent(folder: string, parent: string, requested: string): Promise<SaveResult> {
  try {
    const realBase = await realpath(path.resolve(folder));
    if (!(await stat(parent)).isDirectory()) {
      return refused(`The parent of ${requested} is not a folder; save into an existing folder.`);
    }
    const real = await realpath(parent);
    const relative = path.relative(realBase, real);
    if (!isInside(relative)) return refused(outside(requested, path.resolve(folder)));
    if (hasDotPart(relative)) return refused(dotPart(requested));
    return { ok: true, path: real };
  } catch (error: unknown) {
    return refused(fileSystemProblem(error, requested));
  }
}

function succeeded(): boolean {
  return true;
}

function failed(): boolean {
  return false;
}

export function isInside(relative: string): boolean {
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function hasDotPart(relative: string): boolean {
  return relative.split(path.sep).some((part) => part.startsWith("."));
}

function fileSystemProblem(error: unknown, requested: string): string {
  const code = codeOf(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return `The folder of ${requested} does not exist; save into an existing folder.`;
  }
  return couldNotSave(requested);
}

export function codeOf(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function refused(message: string): SaveResult {
  return { ok: false, message };
}

function outside(requested: string, folder: string): string {
  return `${requested} is outside the folder Foxleash was started in, ${folder}; give a path inside it.`;
}

function dotPart(requested: string): string {
  return `${requested} has a folder or file name starting with a dot; choose a path without one.`;
}

function couldNotSave(requested: string): string {
  return `Foxleash could not save the screenshot to ${requested}; choose another path.`;
}
