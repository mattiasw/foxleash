import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  checkSocketDir,
  ensureSocketDir,
  isAlive,
  listSockets,
  resolveSocketDir,
  SocketDirError,
  socketPath,
} from "./socket-dir.ts";

const uid = currentUid();
const root = mkdtempSync("/tmp/foxhand-test-");
const servers: net.Server[] = [];

after(async () => {
  await Promise.all(servers.map(closeServer));
  rmSync(root, { recursive: true, force: true });
});

describe("resolveSocketDir", () => {
  it("uses a private XDG_RUNTIME_DIR", () => {
    const xdg = privateDir("xdg-ok");
    assert.deepEqual(resolveSocketDir({ XDG_RUNTIME_DIR: xdg }, uid, missing("run-a")), {
      dir: path.join(xdg, "foxhand"),
      skipped: [],
    });
  });

  it("normalises a trailing slash in XDG_RUNTIME_DIR", () => {
    const xdg = privateDir("xdg-slash");
    assert.deepEqual(resolveSocketDir({ XDG_RUNTIME_DIR: `${xdg}/` }, uid, missing("run-b")), {
      dir: `${xdg}/foxhand`,
      skipped: [],
    });
  });

  it("uses <runUserBase>/<uid> when XDG_RUNTIME_DIR is unset", () => {
    const runUserBase = privateDir("run-c");
    const base = privateDir(path.join("run-c", String(uid)));
    assert.deepEqual(resolveSocketDir({}, uid, runUserBase), {
      dir: path.join(base, "foxhand"),
      skipped: [],
    });
  });

  it("falls back to /tmp/foxhand-<uid> and lists the missing base", () => {
    const runUserBase = missing("run-d");
    assert.deepEqual(resolveSocketDir({}, uid, runUserBase), {
      dir: `/tmp/foxhand-${uid}`,
      skipped: [`${runUserBase}/${uid} does not exist`],
    });
  });

  it("skips an XDG_RUNTIME_DIR open to other users and uses the next candidate", () => {
    const xdg = privateDir("xdg-open");
    chmodSync(xdg, 0o755);
    const runUserBase = privateDir("run-e");
    const base = privateDir(path.join("run-e", String(uid)));
    assert.deepEqual(resolveSocketDir({ XDG_RUNTIME_DIR: xdg }, uid, runUserBase), {
      dir: path.join(base, "foxhand"),
      skipped: [`XDG_RUNTIME_DIR ${xdg} is open to other users (mode 0755)`],
    });
  });

  it("skips a relative XDG_RUNTIME_DIR", () => {
    const runUserBase = missing("run-f");
    assert.deepEqual(resolveSocketDir({ XDG_RUNTIME_DIR: "run/xdg" }, uid, runUserBase), {
      dir: `/tmp/foxhand-${uid}`,
      skipped: [
        "XDG_RUNTIME_DIR run/xdg is not an absolute path",
        `${runUserBase}/${uid} does not exist`,
      ],
    });
  });

  it("skips an empty XDG_RUNTIME_DIR", () => {
    const runUserBase = missing("run-g");
    assert.deepEqual(resolveSocketDir({ XDG_RUNTIME_DIR: "" }, uid, runUserBase), {
      dir: `/tmp/foxhand-${uid}`,
      skipped: ["XDG_RUNTIME_DIR is empty", `${runUserBase}/${uid} does not exist`],
    });
  });

  it("checks the normalised XDG_RUNTIME_DIR it names", () => {
    const xdg = privateDir("xdg-dots");
    const runUserBase = missing("run-h");
    assert.deepEqual(resolveSocketDir({ XDG_RUNTIME_DIR: `${xdg}/../nope/.` }, uid, runUserBase), {
      dir: `/tmp/foxhand-${uid}`,
      skipped: [
        `XDG_RUNTIME_DIR ${path.join(root, "nope")} does not exist`,
        `${runUserBase}/${uid} does not exist`,
      ],
    });
  });

  it("refuses a symlinked XDG_RUNTIME_DIR given with a trailing slash", () => {
    const link = path.join(root, "xdg-link");
    symlinkSync(privateDir("xdg-link-target"), link);
    const runUserBase = missing("run-i");
    assert.deepEqual(resolveSocketDir({ XDG_RUNTIME_DIR: `${link}/` }, uid, runUserBase), {
      dir: `/tmp/foxhand-${uid}`,
      skipped: [
        `XDG_RUNTIME_DIR ${link} is not a directory`,
        `${runUserBase}/${uid} does not exist`,
      ],
    });
  });

  it("checks the directory it names when .. follows a symlink", () => {
    // The kernel reads <root>/xdg-hop/../xdg-lexical as <root>/xdg-far/xdg-lexical.
    privateDir("xdg-far");
    const hop = path.join(root, "xdg-hop");
    symlinkSync(privateDir(path.join("xdg-far", "deep")), hop);
    privateDir(path.join("xdg-far", "xdg-lexical"));
    const lexical = privateDir("xdg-lexical");
    chmodSync(lexical, 0o755);
    const runUserBase = missing("run-j");
    const env = { XDG_RUNTIME_DIR: `${hop}/../xdg-lexical` };
    assert.deepEqual(resolveSocketDir(env, uid, runUserBase), {
      dir: `/tmp/foxhand-${uid}`,
      skipped: [
        `XDG_RUNTIME_DIR ${lexical} is open to other users (mode 0755)`,
        `${runUserBase}/${uid} does not exist`,
      ],
    });
  });
});

describe("checkSocketDir", () => {
  it("accepts a private directory of the user", () => {
    assert.deepEqual(checkSocketDir(privateDir("check-ok"), uid), { ok: true });
  });

  it("accepts a 0500 directory", (t) => {
    const dir = privateDir("check-0500");
    chmodSync(dir, 0o500);
    t.after(() => chmodSync(dir, 0o700));
    assert.deepEqual(checkSocketDir(dir, uid), { ok: true });
  });

  for (const [mode, text] of [
    [0o755, "0755"],
    [0o750, "0750"],
    [0o701, "0701"],
    [0o070, "0070"],
  ] as const) {
    it(`refuses a directory with mode ${text}`, (t) => {
      const dir = privateDir(`check-${text}`);
      chmodSync(dir, mode);
      t.after(() => chmodSync(dir, 0o700));
      assert.deepEqual(checkSocketDir(dir, uid), {
        ok: false,
        reason: `is open to other users (mode ${text})`,
      });
    });
  }

  it("names only the permission bits of a sticky directory", (t) => {
    const dir = privateDir("check-sticky");
    chmodSync(dir, 0o1755);
    t.after(() => chmodSync(dir, 0o700));
    assert.equal(statSync(dir).mode & 0o7777, 0o1755);
    assert.deepEqual(checkSocketDir(dir, uid), {
      ok: false,
      reason: "is open to other users (mode 0755)",
    });
  });

  it("refuses a symlink to a private directory", () => {
    const link = path.join(root, "check-link");
    symlinkSync(privateDir("check-target"), link);
    assert.deepEqual(checkSocketDir(link, uid), { ok: false, reason: "is not a directory" });
  });

  it("refuses a symlink given with a trailing slash or /.", () => {
    const link = path.join(root, "check-link-slash");
    symlinkSync(privateDir("check-slash-target"), link);
    for (const dir of [`${link}/`, `${link}/.`]) {
      assert.deepEqual(checkSocketDir(dir, uid), { ok: false, reason: "is not a directory" }, dir);
    }
  });

  it("refuses a regular file", () => {
    assert.deepEqual(checkSocketDir(file("check-file"), uid), {
      ok: false,
      reason: "is not a directory",
    });
  });

  it("refuses a directory of another uid", () => {
    assert.deepEqual(checkSocketDir(privateDir("check-uid"), uid + 1), {
      ok: false,
      reason: `belongs to uid ${uid}, not you (uid ${uid + 1})`,
    });
  });

  it("refuses a missing path", () => {
    assert.deepEqual(checkSocketDir(missing("check-missing"), uid), {
      ok: false,
      reason: "does not exist",
    });
  });

  it("refuses a path below a regular file with the error code", () => {
    assert.deepEqual(checkSocketDir(path.join(file("check-parent"), "sub"), uid), {
      ok: false,
      reason: "cannot be read: ENOTDIR",
    });
  });
});

describe("ensureSocketDir", () => {
  it("creates the directory with mode 0700, and accepts it on a second call", () => {
    const dir = path.join(privateDir("ensure-new"), "foxhand");
    ensureSocketDir(dir, uid);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    ensureSocketDir(dir, uid);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it("throws when the base does not exist", () => {
    const dir = path.join(missing("ensure-missing"), "foxhand");
    assert.throws(
      () => ensureSocketDir(dir, uid),
      (error: unknown) => {
        assert.ok(error instanceof SocketDirError);
        assert.equal(error.name, "SocketDirError");
        assert.equal(error.message, sentence(dir, "cannot be created: ENOENT"));
        return true;
      },
    );
  });

  it("refuses an existing directory open to other users and leaves its mode alone", () => {
    const dir = privateDir("ensure-open");
    chmodSync(dir, 0o755);
    assert.throws(() => ensureSocketDir(dir, uid), {
      name: "SocketDirError",
      message: sentence(dir, "is open to other users (mode 0755)"),
    });
    assert.equal(statSync(dir).mode & 0o777, 0o755);
  });

  it("refuses a planted symlink", () => {
    const dir = path.join(root, "ensure-link");
    symlinkSync(privateDir("ensure-target"), dir);
    assert.throws(() => ensureSocketDir(dir, uid), {
      name: "SocketDirError",
      message: sentence(dir, "is not a directory"),
    });
  });

  it("refuses a planted symlink given with a trailing slash, naming the resolved path", () => {
    const link = path.join(root, "ensure-link-slash");
    symlinkSync(privateDir("ensure-slash-target"), link);
    assert.throws(() => ensureSocketDir(`${link}/`, uid), {
      name: "SocketDirError",
      message: sentence(link, "is not a directory"),
    });
  });
});

describe("listSockets", () => {
  it("lists the user's sockets newest first and ignores everything else", async () => {
    const dir = privateDir("list");
    const older = await listen(path.join(dir, "200.sock"));
    const newest = await listen(path.join(dir, "300.sock"));
    const oldest = await listen(path.join(dir, "100.sock"));
    const highest = await listen(path.join(dir, "2147483647.sock"));
    utimesSync(oldest, 1000, 1000);
    utimesSync(older, 2000, 2000);
    utimesSync(newest, 4000, 4000);
    utimesSync(highest, 3000, 3000);
    for (const name of ["0.sock", "01.sock", "abc.sock", "2147483648.sock", "123.socket"]) {
      await listen(path.join(dir, name));
    }
    writeFileSync(path.join(dir, "123.sock"), "");
    symlinkSync(newest, path.join(dir, "400.sock"));
    assert.deepEqual(listSockets(dir, uid), [
      { path: newest, pid: 300, mtimeMs: 4_000_000 },
      { path: highest, pid: 2147483647, mtimeMs: 3_000_000 },
      { path: older, pid: 200, mtimeMs: 2_000_000 },
      { path: oldest, pid: 100, mtimeMs: 1_000_000 },
    ]);
  });

  it("returns [] for a missing directory", () => {
    assert.deepEqual(listSockets(missing("list-missing"), uid), []);
  });

  it("refuses a regular file and a directory of another uid or open to others", () => {
    const sockets = privateDir("list-target");
    const open = privateDir("list-open");
    chmodSync(open, 0o755);
    const cases = [
      [file("list-file"), uid, "is not a directory"],
      [sockets, uid + 1, `belongs to uid ${uid}, not you (uid ${uid + 1})`],
      [open, uid, "is open to other users (mode 0755)"],
    ] as const;
    for (const [dir, owner, reason] of cases) {
      assert.throws(() => listSockets(dir, owner), {
        name: "SocketDirError",
        message: sentence(dir, reason),
      });
    }
  });

  it("refuses a symlinked directory even when it holds the user's sockets", async () => {
    const sockets = privateDir("list-linked");
    await listen(path.join(sockets, "500.sock"));
    const link = path.join(root, "list-linked-link");
    symlinkSync(sockets, link);
    for (const dir of [link, `${link}/`, `${link}/.`]) {
      assert.throws(() => listSockets(dir, uid), {
        name: "SocketDirError",
        message: sentence(link, "is not a directory"),
      });
    }
  });

  it("reads the directory it checked when .. follows a symlink", async () => {
    // The kernel reads <root>/list-hop/../list-lexical as <root>/list-far/list-lexical.
    privateDir("list-far");
    const hop = path.join(root, "list-hop");
    symlinkSync(privateDir(path.join("list-far", "deep")), hop);
    await listen(path.join(privateDir(path.join("list-far", "list-lexical")), "600.sock"));
    const own = await listen(path.join(privateDir("list-lexical"), "700.sock"));
    utimesSync(own, 5000, 5000);
    assert.deepEqual(listSockets(`${hop}/../list-lexical`, uid), [
      { path: own, pid: 700, mtimeMs: 5_000_000 },
    ]);
  });

  it("refuses a directory it cannot read", {
    skip: uid === 0 ? "root reads any directory" : false,
  }, (t) => {
    const dir = privateDir("list-unreadable");
    chmodSync(dir, 0o300);
    t.after(() => chmodSync(dir, 0o700));
    assert.throws(() => listSockets(dir, uid), {
      name: "SocketDirError",
      message: sentence(dir, "cannot be read: EACCES"),
    });
  });

  it("skips an entry it cannot lstat", (t) => {
    const dir = privateDir("list-locked");
    writeFileSync(path.join(dir, "5.sock"), "");
    chmodSync(dir, 0o400);
    t.after(() => chmodSync(dir, 0o700));
    assert.deepEqual(listSockets(dir, uid), []);
  });
});

describe("socketPath and isAlive", () => {
  it("names a socket <dir>/<pid>.sock", () => {
    assert.equal(socketPath("/run/user/1000/foxhand", 4242), "/run/user/1000/foxhand/4242.sock");
  });

  it("finds this process alive", () => {
    assert.equal(isAlive(process.pid), true);
  });

  it("finds a pid no Linux process has dead", () => {
    assert.equal(isAlive(0x7fffffff), false);
  });

  it("finds pid 1 alive, whether or not it may be signalled", () => {
    assert.equal(isAlive(1), true);
  });
});

function currentUid(): number {
  const getuid = process.getuid;
  assert.ok(getuid !== undefined, "process.getuid is unavailable");
  return getuid();
}

function privateDir(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function missing(name: string): string {
  return path.join(root, name);
}

function file(name: string): string {
  const target = path.join(root, name);
  writeFileSync(target, "");
  return target;
}

function sentence(dir: string, reason: string): string {
  return `The Foxhand socket directory ${dir} ${reason}; remove it, or set XDG_RUNTIME_DIR to a private directory, and try again.`;
}

async function listen(socket: string): Promise<string> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  return socket;
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
