import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fsPromises, {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { savePathProblem, savePng } from "./save-file.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("savePng", () => {
  let outer = "";
  let work = "";
  let names = 0;

  before(async () => {
    outer = await realpath(await mkdtemp(join(tmpdir(), "fh-save-")));
    work = join(outer, "work");
    await mkdir(work);
    // A sibling whose name starts with the folder's name.
    await mkdir(join(outer, "work-x"));
    await mkdir(join(work, "sub"));
    await mkdir(join(work, "sub", ".git"));
    await mkdir(join(work, ".hidden"));
    await mkdir(join(work, "out.png"));
    await writeFile(join(work, "notes.txt"), "notes");
    await writeFile(join(work, "taken.png"), "taken");
    await symlink(join(outer, "work-x"), join(work, "out"));
    await symlink(join(work, "sub", ".git"), join(work, "hooks"));
    await symlink(join(outer, "elsewhere.png"), join(work, "link.png"));
    await symlink(join(work, "loop"), join(work, "loop"));
    await symlink(work, join(outer, "via"));
  });

  after(async () => {
    await rm(outer, { recursive: true, force: true });
  });

  /** A file name no other test uses. */
  function fresh(): string {
    names += 1;
    return `shot-${names}.png`;
  }

  it("writes the bytes to a new file with mode 0600 and returns its real path", async () => {
    const name = fresh();
    assert.deepEqual(await savePng(work, name, PNG), { ok: true, path: join(work, name) });
    assert.deepEqual(new Uint8Array(await readFile(join(work, name))), PNG);
    assert.equal((await stat(join(work, name))).mode & 0o777, 0o600);
  });

  it("saves into an existing folder, also by an absolute path inside the folder", async () => {
    const name = fresh();
    assert.deepEqual(await savePng(work, `sub/${name}`, PNG), {
      ok: true,
      path: join(work, "sub", name),
    });
    const absolute = join(work, fresh());
    assert.deepEqual(await savePng(work, absolute, PNG), { ok: true, path: absolute });
  });

  it("takes a path that leaves a folder and comes back, and .PNG in any case", async () => {
    const name = fresh();
    assert.deepEqual(await savePng(work, `sub/../${name}`, PNG), {
      ok: true,
      path: join(work, name),
    });
    const upper = fresh().replace(".png", ".PNG");
    assert.deepEqual(await savePng(work, upper, PNG), { ok: true, path: join(work, upper) });
  });

  it("returns the real path when the folder is given through a symlink", async () => {
    const name = fresh();
    assert.deepEqual(await savePng(join(outer, "via"), name, PNG), {
      ok: true,
      path: join(work, name),
    });
  });

  it("refuses an existing name, also a symlink there, and leaves it as it was", async () => {
    assert.deepEqual(await savePng(work, "taken.png", PNG), {
      ok: false,
      message: "taken.png already exists; choose another name.",
    });
    assert.equal(await readFile(join(work, "taken.png"), "utf8"), "taken");
    assert.deepEqual(await savePng(work, "link.png", PNG), {
      ok: false,
      message: "link.png already exists; choose another name.",
    });
    assert.ok((await lstat(join(work, "link.png"))).isSymbolicLink());
    await assert.rejects(stat(join(outer, "elsewhere.png")), { code: "ENOENT" });
  });

  it("refuses each path it must not write, and creates nothing", async () => {
    const cases: [string, string][] = [
      ["", "saveTo is empty; give a path ending in .png."],
      ["a\0.png", "saveTo contains a NUL character; give a path without one."],
      ["shot.jpg", "shot.jpg does not end in .png; give a path ending in .png."],
      ["shot.png/", "shot.png/ does not end in .png; give a path ending in .png."],
      ["shot.png.txt", "shot.png.txt does not end in .png; give a path ending in .png."],
      [
        "../shot.png",
        `../shot.png is outside the folder Foxhand was started in, ${work}; give a path inside it.`,
      ],
      [
        "../work-x/shot.png",
        `../work-x/shot.png is outside the folder Foxhand was started in, ${work}; give a path inside it.`,
      ],
      [
        join(outer, "shot.png"),
        `${join(outer, "shot.png")} is outside the folder Foxhand was started in, ${work}; give a path inside it.`,
      ],
      [
        "out/shot.png",
        `out/shot.png is outside the folder Foxhand was started in, ${work}; give a path inside it.`,
      ],
      [
        ".shot.png",
        ".shot.png has a folder or file name starting with a dot; choose a path without one.",
      ],
      [
        ".hidden/shot.png",
        ".hidden/shot.png has a folder or file name starting with a dot; choose a path without one.",
      ],
      [
        "sub/.git/shot.png",
        "sub/.git/shot.png has a folder or file name starting with a dot; choose a path without one.",
      ],
      [
        "hooks/shot.png",
        "hooks/shot.png has a folder or file name starting with a dot; choose a path without one.",
      ],
      [
        "missing/shot.png",
        "The folder of missing/shot.png does not exist; save into an existing folder.",
      ],
      [
        "notes.txt/sub/shot.png",
        "The folder of notes.txt/sub/shot.png does not exist; save into an existing folder.",
      ],
      [
        "notes.txt/shot.png",
        "The parent of notes.txt/shot.png is not a folder; save into an existing folder.",
      ],
      [
        `${"a".repeat(300)}.png`,
        `Foxhand could not save the screenshot to ${"a".repeat(300)}.png; choose another path.`,
      ],
      [
        "loop/shot.png",
        "Foxhand could not save the screenshot to loop/shot.png; choose another path.",
      ],
    ];
    const before = await tree(outer);
    for (const [requested, message] of cases) {
      assert.deepEqual(await savePng(work, requested, PNG), { ok: false, message }, requested);
    }
    assert.deepEqual(await tree(outer), before);
  });

  it("refuses the folder itself as the file", async () => {
    const folder = join(work, "out.png");
    assert.equal(
      savePathProblem(folder, folder),
      `${folder} is outside the folder Foxhand was started in, ${folder}; give a path inside it.`,
    );
  });

  it("refuses everything when the save folder does not exist", async () => {
    assert.deepEqual(await savePng(join(outer, "gone"), "shot.png", PNG), {
      ok: false,
      message: "The folder of shot.png does not exist; save into an existing folder.",
    });
  });

  it("leaves no file behind when writing fails", async (t) => {
    const handles = await fileHandlePrototype(work);
    t.mock.method(handles, "writeFile", async () => {
      throw new Error("EIO: i/o error, write");
    });
    const name = fresh();
    assert.deepEqual(await withSlowUnlink(t, () => savePng(work, name, PNG)), {
      ok: false,
      message: `Foxhand could not save the screenshot to ${name}; choose another path.`,
    });
    assert.throws(() => lstatSync(join(work, name)), { code: "ENOENT" });
  });

  it("leaves no file behind when closing it fails", async (t) => {
    const handles = await fileHandlePrototype(work);
    const writeFileOf: unknown = Reflect.get(handles, "writeFile");
    let closeFailed = false;
    assert.ok(typeof writeFileOf === "function");
    // Each handle has its own close, so the write replaces it on the handle it writes through.
    t.mock.method(handles, "writeFile", async function (this: object, data: Uint8Array) {
      await Reflect.apply(writeFileOf, this, [data]);
      const close: unknown = Reflect.get(this, "close");
      assert.ok(typeof close === "function");
      Reflect.set(this, "close", async () => {
        await Reflect.apply(close, this, []);
        closeFailed = true;
        throw new Error("EIO: i/o error, close");
      });
    });
    const name = fresh();
    assert.deepEqual(await withSlowUnlink(t, () => savePng(work, name, PNG)), {
      ok: false,
      message: `Foxhand could not save the screenshot to ${name}; choose another path.`,
    });
    assert.equal(closeFailed, true);
    assert.throws(() => lstatSync(join(work, name)), { code: "ENOENT" });
  });
});

describe("savePathProblem", () => {
  it("takes a plain path inside the folder without touching the file system", () => {
    assert.equal(savePathProblem("/nonexistent/work", "a/b/shot.png"), undefined);
    assert.equal(savePathProblem("/nonexistent/work/", "/nonexistent/work/shot.png"), undefined);
    assert.equal(savePathProblem("/", "shot.png"), undefined);
  });

  it("refuses a sibling folder that shares the folder's name as a prefix", () => {
    assert.equal(
      savePathProblem("/nonexistent/work", "/nonexistent/work-x/shot.png"),
      "/nonexistent/work-x/shot.png is outside the folder Foxhand was started in, /nonexistent/work; give a path inside it.",
    );
  });

  it("refuses a name starting with .. that stays inside the folder only as a dot name", () => {
    assert.equal(
      savePathProblem("/nonexistent/work", "..shot.png"),
      "..shot.png has a folder or file name starting with a dot; choose a path without one.",
    );
  });
});

/** Every entry below `folder`, as sorted relative paths. */
async function tree(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true });
  return entries.sort();
}

/**
 * Runs `action` with fs/promises' unlink delayed, so a file savePng removes without waiting is
 * still there when it answers.
 */
async function withSlowUnlink<T>(t: TestContext, action: () => Promise<T>): Promise<T> {
  const unlink = fsPromises.unlink;
  const slow = t.mock.method(fsPromises, "unlink", async (file: string) => {
    await sleep(50);
    await unlink(file);
  });
  syncBuiltinESMExports();
  try {
    return await action();
  } finally {
    slow.mock.restore();
    syncBuiltinESMExports();
  }
}

async function fileHandlePrototype(folder: string): Promise<FileHandle> {
  const handle = await open(folder, "r");
  try {
    return Object.getPrototypeOf(handle);
  } finally {
    await handle.close();
  }
}
