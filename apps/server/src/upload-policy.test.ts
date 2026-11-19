import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants, readdirSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  FRESH_FILE_MS,
  fileType,
  type ReadContext,
  type ReadHandle,
  type ReadResult,
  readAllowedFile,
  uploadFolders,
} from "./upload-policy.ts";

const LIMIT = { timeout: 10_000 };
const BUDGET = 10 * 1024 * 1024;
const DOT =
  "has a folder or file name starting with a dot below its upload folder; Foxleash never uploads those.";
const KEY = "is named like a key file; Foxleash never uploads those.";
const PRIVATE_KEY = "holds a private key; Foxleash never uploads those.";
const NOT_FILE = "is not a regular file; Foxleash uploads only files.";
const MISSING = "does not exist.";
const UNREADABLE = "cannot be read.";
const CHANGED = "changed while Foxleash read it; try again.";
const FRESH = "was saved or changed a moment ago; try again in a few seconds.";
const HOME_NOTE = "is your home folder or contains it, so it would cover your whole home folder";
const DOT_NOTE = "is inside a folder whose name starts with a dot";
const FLAGS = constants.O_RDONLY | constants.O_NOCTTY | constants.O_NONBLOCK;
// The body is the base64 of "openssh-key-v1" without its NUL, so only the PEM lines mark it.
const OPENSSH_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE=\n-----END OPENSSH PRIVATE KEY-----\n";
const RSA_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----\n";
const CERTIFICATE = "-----BEGIN CERTIFICATE-----\nMIIBszCCAV\n-----END CERTIFICATE-----\n";
// An OpenSSH key's base64 body with its BEGIN and END lines removed.
const BARE_BODY = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQ";

let root = "";
let home = "";
let work = "";
let outside = "";

before(async () => {
  // Not tmpdir(), which may lie in a dot folder, where no default folder is allowed.
  root = await realpath(await mkdtemp("/tmp/fh-policy-"));
  home = join(root, "home");
  work = join(home, "work");
  outside = join(root, "outside");
  for (const folder of [home, work, outside, join(home, ".config", "app"), join(home, ".aws")]) {
    await mkdir(folder, { recursive: true });
  }
  await mkdir(join(work, ".hidden"));
  await mkdir(join(work, "dir"));
  await writeFile(join(work, "ok.txt"), "ok bytes");
  await writeFile(join(work, "server.pem"), "-----BEGIN PRIVATE KEY-----");
  await writeFile(join(work, "plain-key.txt"), OPENSSH_KEY);
  await writeFile(join(work, ".hidden", "x.txt"), "hidden");
  await writeFile(join(work, ".env.local"), "TOKEN=1");
  await writeFile(join(outside, "x.txt"), "outside");
  await writeFile(join(home, ".aws", "credentials"), "secret");
  await writeFile(join(home, ".config", "app", "settings.txt"), "settings");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("uploadFolders", () => {
  it("defaults to the working folder and ~/Downloads when no user-dirs.dirs names one", () => {
    assert.deepEqual(uploadFolders({ env: {}, cwd: work, home }), {
      folders: [work, join(home, "Downloads")],
      notes: [],
    });
    assert.deepEqual(uploadFolders({ env: { FOXLEASH_UPLOAD_DIRS: "" }, cwd: work, home }), {
      folders: [work, join(home, "Downloads")],
      notes: [],
    });
  });

  it("leaves out a working folder that is home or holds it", () => {
    for (const cwd of [home, root, "/"]) {
      assert.deepEqual(
        uploadFolders({ env: {}, cwd, home }),
        { folders: [join(home, "Downloads")], notes: [{ folder: cwd, reason: HOME_NOTE }] },
        cwd,
      );
    }
  });

  it("leaves out a working folder under a dot folder", () => {
    const config = join(home, ".config", "app");
    assert.deepEqual(uploadFolders({ env: {}, cwd: config, home }), {
      folders: [join(home, "Downloads")],
      notes: [{ folder: config, reason: DOT_NOTE }],
    });
  });

  it("leaves out ~/Downloads when it links to home", async () => {
    const linked = join(root, "linked-home");
    await mkdir(linked);
    await symlink(linked, join(linked, "Downloads"));
    assert.deepEqual(uploadFolders({ env: {}, cwd: work, home: linked }), {
      folders: [work],
      notes: [{ folder: join(linked, "Downloads"), reason: HOME_NOTE }],
    });
  });

  it("compares a working folder to home on real paths", async () => {
    const link = join(root, "home-link");
    await symlink(home, link);
    assert.deepEqual(uploadFolders({ env: {}, cwd: link, home }).notes, [
      { folder: link, reason: HOME_NOTE },
    ]);
  });

  it("compares a linked home to the working folder on real paths", async () => {
    const alias = join(root, "home-alias");
    await symlink(home, alias);
    // The cwd is the real home: a cwd of root would be noted even if home were not resolved.
    assert.deepEqual(uploadFolders({ env: {}, cwd: home, home: alias }), {
      folders: [join(alias, "Downloads")],
      notes: [{ folder: home, reason: HOME_NOTE }],
    });
  });

  it("notes a working folder that is gone and keeps ~/Downloads", () => {
    assert.deepEqual(uploadFolders({ env: {}, cwd: undefined, home }), {
      folders: [join(home, "Downloads")],
      notes: [{ folder: "the folder Foxleash was started in", reason: "no longer exists" }],
    });
  });

  it("replaces the defaults with FOXLEASH_UPLOAD_DIRS", () => {
    const env = {
      FOXLEASH_UPLOAD_DIRS: `~:~/x::/abs/y/../z:rel/dir:~user/z:${home}/.config/app:/`,
    };
    assert.deepEqual(uploadFolders({ env, cwd: work, home }), {
      folders: [home, join(home, "x"), "/abs/z", join(home, ".config", "app"), "/"],
      notes: [
        { folder: "rel/dir", reason: "is not an absolute path" },
        { folder: "~user/z", reason: "is not an absolute path" },
      ],
    });
  });

  it("leaves no folder when no entry of FOXLEASH_UPLOAD_DIRS is usable", () => {
    assert.deepEqual(uploadFolders({ env: { FOXLEASH_UPLOAD_DIRS: "a:b" }, cwd: work, home }), {
      folders: [],
      notes: [
        { folder: "a", reason: "is not an absolute path" },
        { folder: "b", reason: "is not an absolute path" },
      ],
    });
  });

  it("uses the desktop's download folder instead of ~/Downloads", LIMIT, async () => {
    const own = join(root, "home-translated");
    for (const folder of ["Hämtningar", "Downloads"]) {
      await mkdir(join(own, folder), { recursive: true });
      await writeFile(join(own, folder, "check.txt"), "saved");
    }
    const env = await userDirs('XDG_DOWNLOAD_DIR="$HOME/Hämtningar"\n');
    const { folders, notes } = uploadFolders({ env, cwd: work, home: own });
    assert.deepEqual({ folders, notes }, { folders: [work, join(own, "Hämtningar")], notes: [] });
    const saved = await read(join(own, "Hämtningar", "check.txt"), folders, { home: own });
    assert.equal(saved.ok && saved.bytes.toString(), "saved");
    assert.match(
      reasonOf(await read(join(own, "Downloads", "check.txt"), folders, { home: own })),
      /^is outside the upload folders/,
    );
  });

  it("takes an absolute download folder as written and joins $HOME/ by string", async () => {
    const elsewhere = join(root, "elsewhere", "dl");
    assert.deepEqual(await downloadFolders(`XDG_DOWNLOAD_DIR="${elsewhere}/"\n`), [
      work,
      elsewhere,
    ]);
    assert.deepEqual(await downloadFolders('XDG_DOWNLOAD_DIR="$HOME//dl"\n'), [
      work,
      join(home, "dl"),
    ]);
  });

  it("reads ~/.config/user-dirs.dirs unless XDG_CONFIG_HOME is absolute", async () => {
    const own = join(root, "home-config");
    await mkdir(join(own, ".config"), { recursive: true });
    await writeFile(join(own, ".config", "user-dirs.dirs"), 'XDG_DOWNLOAD_DIR="$HOME/own"\n');
    for (const env of [{}, { XDG_CONFIG_HOME: "" }, { XDG_CONFIG_HOME: "rel/config" }]) {
      assert.deepEqual(
        uploadFolders({ env, cwd: work, home: own }).folders,
        [work, join(own, "own")],
        JSON.stringify(env),
      );
    }
    const env = await userDirs('XDG_DOWNLOAD_DIR="$HOME/configured"\n');
    assert.deepEqual(uploadFolders({ env, cwd: work, home: own }).folders, [
      work,
      join(own, "configured"),
    ]);
  });

  it("reads XDG_DOWNLOAD_DIR lines as xdg-user-dirs writes and reads them", async () => {
    const cases: [string, string][] = [
      ['# XDG_DOWNLOAD_DIR="$HOME/c"\nXDG_DOWNLOAD_DIR="$HOME/d"\n', "d"],
      [' \t XDG_DOWNLOAD_DIR="$HOME/indented"\n', "indented"],
      ['XDG_DOWNLOAD_DIR \t= \t"$HOME/spaced"\n', "spaced"],
      ['XDG_DESKTOP_DIR="$HOME/Skrivbord"\nXDG_DOWNLOAD_DIR="$HOME/d"\n', "d"],
      ['XDG_DOWNLOAD_DIR="$HOME/d"\nXDG_DESKTOP_DIR="$HOME/Skrivbord"\n', "d"],
      ['XDG_DOWNLOAD_DIRS="$HOME/s"\nXDG_DOWNLOAD_DIR="$HOME/d"\n', "d"],
      ['XDG_DOWNLOAD_DIR="$HOME/a\\"b\\\\c"\n', 'a"b\\c'],
      ['XDG_DOWNLOAD_DIR="$HOME/d" # "$HOME/after"\n', "d"],
      ['XDG_DOWNLOAD_DIR="$HOME/first"\nXDG_DOWNLOAD_DIR="$HOME/last"\n', "last"],
      ['XDG_DOWNLOAD_DIR="$HOME/valid"\nXDG_DOWNLOAD_DIR="relative"\n', "valid"],
      ['﻿XDG_DOWNLOAD_DIR="$HOME/bom"\n', "Downloads"],
      ['﻿XDG_DOWNLOAD_DIR="$HOME/bom"\nXDG_DOWNLOAD_DIR="$HOME/d"\n', "d"],
      ['XDG_DOWNLOAD_DIR="$HOME/open\n', "open"],
      ['XDG_DOWNLOAD_DIR="$HOME/end\\', "end\\"],
      ['XDG_DOWNLOAD_DIR="$HOME/a\0b"\n', "a"],
      ['XDG_DESKTOP_DIR="$HOME/x"\r\nXDG_DOWNLOAD_DIR="$HOME/crlf"\r\n', "crlf"],
      ['XDG_DOWNLOAD_DIR="$HOME/line sep"\n', "line sep"],
    ];
    const folders: string[] = [];
    for (const [text] of cases) folders.push((await downloadFolders(text))[1] ?? "none");
    assert.deepEqual(
      folders,
      cases.map(([, folder]) => join(home, folder)),
    );
  });

  it("falls back to ~/Downloads when no line names a valid download folder", async () => {
    const files = [
      "XDG_DOWNLOAD_DIR=$HOME/unquoted\n",
      'XDG_DOWNLOAD_DIR="Downloads"\n',
      'XDG_DOWNLOAD_DIR="$HOMEX/x"\n',
      'XDG_DOWNLOAD_DIR="$HOME"\n',
      'XDG_DOWNLOAD_DIR="~/x"\n',
      'XDG_DOWNLOAD_DIR=""\n',
      'XDG_DOWNLOAD_DIR_="$HOME/x"\n',
      'XDG_DOWNLOAD_DIRx="$HOME/x"\n',
      'XDG_DESKTOP_DIR="$HOME/Desktop"\n',
      "",
    ];
    const folders: string[] = [];
    for (const text of files) folders.push((await downloadFolders(text))[1] ?? "none");
    assert.deepEqual(
      folders,
      files.map(() => join(home, "Downloads")),
    );
  });

  it("falls back to ~/Downloads when user-dirs.dirs is not a small regular file", async () => {
    const line = 'XDG_DOWNLOAD_DIR="$HOME/big"\n';
    const directory = await userDirs("");
    await rm(join(directory.XDG_CONFIG_HOME, "user-dirs.dirs"));
    await mkdir(join(directory.XDG_CONFIG_HOME, "user-dirs.dirs"));
    const device = await userDirs("");
    await rm(join(device.XDG_CONFIG_HOME, "user-dirs.dirs"));
    await symlink("/dev/zero", join(device.XDG_CONFIG_HOME, "user-dirs.dirs"));
    const large = await userDirs(`${"#".repeat(64 * 1024 - line.length)}\n${line}`);
    for (const env of [directory, device, large]) {
      assert.deepEqual(uploadFolders({ env, cwd: work, home }).folders, [
        work,
        join(home, "Downloads"),
      ]);
    }
    const largest = await userDirs(`${"#".repeat(64 * 1024 - 1 - line.length)}\n${line}`);
    assert.deepEqual(uploadFolders({ env: largest, cwd: work, home }).folders, [
      work,
      join(home, "big"),
    ]);
  });

  it("closes user-dirs.dirs after reading it", async () => {
    const file = await userDirs('XDG_DOWNLOAD_DIR="$HOME/d"\n');
    const folder = await userDirs("");
    await rm(join(folder.XDG_CONFIG_HOME, "user-dirs.dirs"));
    await mkdir(join(folder.XDG_CONFIG_HOME, "user-dirs.dirs"));
    const open = readdirSync("/proc/self/fd").length;
    for (let i = 0; i < 20; i += 1) {
      for (const env of [file, folder]) uploadFolders({ env, cwd: work, home });
    }
    assert.equal(readdirSync("/proc/self/fd").length, open);
  });

  it("falls back to ~/Downloads without waiting when user-dirs.dirs is a FIFO", async () => {
    const config = join(root, "config-fifo");
    await mkdir(config);
    assert.equal(spawnSync("mkfifo", [join(config, "user-dirs.dirs")]).status, 0);
    const policy = new URL("./upload-policy.ts", import.meta.url).href;
    // In a child: a blocking open would freeze this thread, timers and all.
    const script = `import { uploadFolders } from ${JSON.stringify(policy)};
      const [config, cwd, home] = process.argv.slice(1);
      const env = { XDG_CONFIG_HOME: config };
      process.stdout.write(JSON.stringify(uploadFolders({ env, cwd, home }).folders));`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script, config, work, home],
      { timeout: 5000, encoding: "utf8" },
    );
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), [work, join(home, "Downloads")]);
  });

  it("leaves out a download folder that is home or under a dot folder, with no fallback", async () => {
    for (const [text, folder, reason] of [
      ['XDG_DOWNLOAD_DIR="$HOME/"\n', home, HOME_NOTE],
      ['XDG_DOWNLOAD_DIR="$HOME/.."\n', root, HOME_NOTE],
      ['XDG_DOWNLOAD_DIR="/"\n', "/", HOME_NOTE],
      ['XDG_DOWNLOAD_DIR="$HOME/.cache/dl"\n', join(home, ".cache", "dl"), DOT_NOTE],
    ] as const) {
      const env = await userDirs(text);
      assert.deepEqual(
        uploadFolders({ env, cwd: work, home }),
        { folders: [work], notes: [{ folder, reason }] },
        text,
      );
    }
  });

  it("replaces a download folder from user-dirs.dirs with FOXLEASH_UPLOAD_DIRS", async () => {
    const env = {
      ...(await userDirs('XDG_DOWNLOAD_DIR="$HOME/Hämtningar"\n')),
      FOXLEASH_UPLOAD_DIRS: outside,
    };
    assert.deepEqual(uploadFolders({ env, cwd: work, home }), { folders: [outside], notes: [] });
  });
});

describe("readAllowedFile accepts", () => {
  it("a file in an upload folder, with its real path, name and bytes", LIMIT, async () => {
    assert.deepEqual(await read(join(work, "ok.txt")), {
      ok: true,
      path: join(work, "ok.txt"),
      name: "ok.txt",
      bytes: Buffer.from("ok bytes"),
    });
  });

  it(
    "a link from outside to a file inside, under its real path and the link's name",
    LIMIT,
    async () => {
      const link = join(outside, "named.txt");
      await symlink(join(work, "ok.txt"), link);
      assert.deepEqual(await read(link), {
        ok: true,
        path: join(work, "ok.txt"),
        name: "named.txt",
        bytes: Buffer.from("ok bytes"),
      });
    },
  );

  it(
    "a path starting with ~/, a relative path, and an absolute one with no cwd",
    LIMIT,
    async () => {
      for (const [requested, cwd] of [
        ["~/work/ok.txt", work],
        ["ok.txt", work],
        ["../work/./ok.txt", work],
        [join(work, "ok.txt"), undefined],
      ] as const) {
        const result = await read(requested, [work], { cwd });
        assert.equal(result.ok && result.path, join(work, "ok.txt"), requested);
      }
    },
  );

  it("a file in a dot folder that is itself an upload folder", LIMIT, async () => {
    const app = join(home, ".config", "app");
    for (const folders of [[app], [home, app]]) {
      const result = await read(join(app, "settings.txt"), folders);
      assert.equal(result.ok && result.bytes.toString(), "settings", folders.join(":"));
    }
  });

  it("names with a key word only before the first dot or inside a part", LIMIT, async () => {
    for (const name of ["key", "pem.txt", "notes.keys", "a.pem-notes", "keystore~"]) {
      await writeFile(join(work, name), "plain");
      assert.equal((await read(join(work, name))).ok, true, name);
    }
  });

  it("files close to a private key that hold none", LIMIT, async () => {
    await expectOutcomes("accepted", [
      ["cert.crt", CERTIFICATE],
      ["public.txt", "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKo\n-----END PUBLIC KEY-----\n"],
      ["rsa-public.txt", "-----BEGIN RSA PUBLIC KEY-----\nMEgCQQC\n-----END RSA PUBLIC KEY-----\n"],
      ["deploy.pub", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI user@host\n"],
      [
        "ssh2.pub",
        '---- BEGIN SSH2 PUBLIC KEY ----\nComment: "rsa-key"\nAAAAB3NzaC1yc2E\n---- END SSH2 PUBLIC KEY ----\n',
      ],
      [
        "pubkey.asc",
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQINBF\n-----END PGP PUBLIC KEY BLOCK-----\n",
      ],
      ["file.sig.asc", "-----BEGIN PGP SIGNATURE-----\n\niQIzBAAB\n-----END PGP SIGNATURE-----\n"],
      ["recipients.txt", "age1qyqszqgpqyqszqgpqyqszqgpqyqszqgp\n"],
      ["cert-data.yaml", `client-certificate-data: ${base64(CERTIFICATE)}\n`],
      ["notes.md", "Keep the private key out of the repository. Never paste a PRIVATE KEY here.\n"],
    ]);
  });

  it(
    "binary OpenPGP files that hold no secret key, and headers that do not frame one",
    LIMIT,
    async () => {
      const harmless = "ciphertext\n";
      await expectOutcomes("accepted", [
        ["old-version-1", packet([0x94, 0x58], 0x58, 1)],
        ["old-version-7", packet([0x94, 0x58], 0x58, 7)],
        ["new-version-1", packet([0xc5, 0x58], 0x58, 1)],
        ["new-version-7", packet([0xc5, 0x58], 0x58, 7)],
        // Each declared length one byte past the file's end.
        ["short-old-one-octet", packet([0x94, 0x58], 0x57)],
        ["short-old-two-octet", packet([0x95, 0x01, 0x00], 255)],
        ["short-old-four-octet", packet([0x96, 0x00, 0x00, 0x01, 0x00], 255)],
        ["short-new-one-octet", packet([0xc5, 0x58], 87)],
        ["short-new-two-octet-low", packet([0xc5, 0xc0, 0x00], 191)],
        ["short-new-two-octet-high", packet([0xc5, 0xdf, 0xff], 8382)],
        ["short-new-two-octet-mixed", packet([0xc5, 0xc1, 0x05], 452)],
        ["short-new-five-octet", packet([0xc5, 0xff, 0x00, 0x00, 0x01, 0x00], 255)],
        // Below the smallest body a secret key packet has.
        ["body-39", packet([0x94, 0x27], 39)],
        ["body-0", Buffer.from([0x94, 0x00, 0x04, 0x00, 0x00])],
        ["msgpack-array", Buffer.from([0x94, 0x01, 0x02, 0x03, 0x04])],
        // New-format tags 21 and 37, whose low bits are 5.
        ["new-tag-21", packet([0xd5, 0x58], 0x58)],
        ["new-tag-37", packet([0xe5, 0x58], 0x58)],
        ["huge-length", Buffer.from([0x96, 0xff, 0xff, 0xff, 0xff, 0x04])],
        ["empty", Buffer.alloc(0)],
        ["cut-95", Buffer.from([0x95])],
        ["cut-95-01", Buffer.from([0x95, 0x01])],
        ["cut-96", Buffer.from([0x96, 0x00, 0x00])],
        ["cut-c5", Buffer.from([0xc5])],
        ["cut-c5-c0", Buffer.from([0xc5, 0xc0])],
        ["cut-c5-ff", Buffer.from([0xc5, 0xff, 0x00, 0x00])],
        ["indeterminate", packet([0x97], 0x58)],
        ["partial-low", packet([0xc5, 0xe0], 9000)],
        ["partial-high", packet([0xc5, 0xfe], 17000)],
        ["public-old", packet([0x98, 0x33], 0x33)],
        ["public-old-two-octet", packet([0x99, 0x01, 0x0d], 0x10d)],
        ["public-new", packet([0xc6, 0x58], 0x58)],
        ["pkesk-old", packet([0x84, 0x5e], 0x5e, 3)],
        ["pkesk-old-two-octet", packet([0x85, 0x01, 0x0c], 0x10c, 3)],
        ["pkesk-new", packet([0xc1, 0x5e], 0x5e, 3)],
        ["skesk-old", packet([0x8c, 0x0d], 0x0d)],
        ["skesk-new", packet([0xc3, 0x0d], 0x0d)],
        ["signature", packet([0x89, 0x01, 0x33], 0x133)],
        // Bit 7 clear, with the other bits of a tag 5 header.
        ["no-packet-old-bits", packet([0x14, 0x58], 0x58)],
        ["no-packet-new-bits", packet([0x45, 0x58], 0x58)],
        ["backup.gpg", harmless],
        ["pubring.gpg", harmless],
        ["pubring.kbx", harmless],
      ]);
    },
  );

  it("a file that fills the budget exactly", LIMIT, async () => {
    const result = await read(join(work, "ok.txt"), [work], { remaining: 8 });
    assert.equal(result.ok, true);
  });

  it("a file read in several short reads", LIMIT, async () => {
    const result = await read(join(work, "ok.txt"), [work], {
      open: async (file, flags) => shortReads(await open(file, flags)),
    });
    assert.deepEqual(result.ok && result.bytes, Buffer.from("ok bytes"));
  });

  it("a file when its descriptor fails to close", LIMIT, async () => {
    const result = await read(join(work, "ok.txt"), [work], {
      open: async (file, flags) => {
        const handle = await open(file, flags);
        return {
          fd: handle.fd,
          stat: () => handle.stat(),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            await handle.close();
            throw Object.assign(new Error("close failed"), { code: "EIO" });
          },
        };
      },
    });
    assert.equal(result.ok, true);
  });

  it("a file only once its descriptor is closed", LIMIT, async () => {
    let closed = false;
    const result = await read(join(work, "ok.txt"), [work], {
      open: async (file, flags) => {
        const handle = await open(file, flags);
        return {
          fd: handle.fd,
          stat: () => handle.stat(),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            await new Promise((resolve) => setImmediate(resolve));
            await handle.close();
            closed = true;
          },
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(closed, true);
  });

  it("a file in the second folder when the first does not exist", LIMIT, async () => {
    const result = await read(join(work, "ok.txt"), [join(root, "missing"), work]);
    assert.equal(result.ok, true);
  });
});

describe("readAllowedFile refuses", () => {
  it("a file outside every folder, naming the folders", LIMIT, async () => {
    assert.deepEqual(await read(join(outside, "x.txt"), [work, join(home, "Downloads")]), {
      ok: false,
      reason: `is outside the upload folders (${work}, ${join(home, "Downloads")}); the user can change them with FOXLEASH_UPLOAD_DIRS.`,
    });
    assert.deepEqual(await read(join(outside, "x.txt"), []), {
      ok: false,
      reason:
        "is outside the upload folders (none); the user can change them with FOXLEASH_UPLOAD_DIRS.",
    });
  });

  it("a link inside that leads outside, and a path that climbs out", LIMIT, async () => {
    await symlink(join(outside, "x.txt"), join(work, "out-link.txt"));
    for (const requested of [
      join(work, "out-link.txt"),
      join(work, "..", "..", "outside", "x.txt"),
    ]) {
      assert.match(reasonOf(await read(requested)), /^is outside the upload folders/, requested);
    }
  });

  it("a name below the folder starting with a dot", LIMIT, async () => {
    assert.equal(reasonOf(await read(join(home, ".aws", "credentials"), [home])), DOT);
    assert.equal(reasonOf(await read(join(work, ".hidden", "x.txt"))), DOT);
    assert.equal(reasonOf(await read(join(work, ".env.local"))), DOT);
  });

  it("key-shaped names, whatever their case", LIMIT, async () => {
    for (const name of [
      "id_ed25519",
      "ID_RSA",
      "server.PEM",
      "tls.key",
      "cert.p12",
      "cert.pfx",
      "putty.ppk",
      "store.jks",
      "release.keystore",
      "server.pem.bak",
      "tls.key~",
      "tls.KEY~~.1",
      "backup.p12.zip",
      "vault.kdbx",
      "Passwords.KDBX",
      "backup.kdbx~",
      "krb5.keytab",
      "HTTP.KEYTAB",
      "krb5cc_1000",
      "KRB5CC_1000",
      "krb5cc_1000_AbC123",
      "krb5cc",
      "secring.gpg",
      "SECRING.GPG",
      "secring.gpg~",
      "secring.gpg.bak",
      "secring.pgp",
      "secring.skr",
      "secring",
      "secring-old.gpg",
      "x.skr",
      "X.SKR~",
    ]) {
      await writeFile(join(work, name), "key");
      assert.equal(reasonOf(await read(join(work, name))), KEY, name);
    }
  });

  it("files that hold a private key, whatever their name", LIMIT, async () => {
    const serviceAccount = `{
  "type": "service_account",
  "project_id": "demo-project",
  "private_key_id": "0123456789abcdef",
  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----\\n",
  "client_email": "demo@demo-project.iam.gserviceaccount.com"
}
`;
    await expectOutcomes(PRIVATE_KEY, [
      ["deploy", OPENSSH_KEY],
      ["key.txt", RSA_KEY],
      ["serviceAccountKey.json", serviceAccount],
      [
        "enc.txt",
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkq\n-----END ENCRYPTED PRIVATE KEY-----\n",
      ],
      [
        "secret.asc",
        "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----\n",
      ],
      [
        "ssh2-key",
        '---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nComment: "rsa-key"\nP2/56wAAAi\n---- END SSH2 ENCRYPTED PRIVATE KEY ----\n',
      ],
      ["putty.txt", "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: x\n"],
      [
        "age.txt",
        "# created: 2026-01-01T00:00:00Z\n# public key: age1qyqszqgpqyqszqgpqyqszqgpqyqszqgp\nAGE-SECRET-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGP\n",
      ],
      ["bare-body.txt", `${BARE_BODY}\n`],
      ["key.bin", Buffer.from(BARE_BODY, "base64")],
      [
        "late.log",
        `${"a".repeat(1024 * 1024 + 1)}-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----\n`,
      ],
    ]);
  });

  it("a binary OpenPGP secret key at the file's start, whatever its name", LIMIT, async () => {
    // The start of a real gpg 2.x Ed25519 export: Secret-Key packet, key version 4.
    const gpgStart = [0x94, 0x58, 0x04, 0x6a, 0xfc, 0x24, 0x10, 0x16, 0x09, 0x2b, 0x06, 0x01];
    const gpgPacket = Buffer.concat([
      Buffer.from(gpgStart),
      Buffer.alloc(2 + 0x58 - gpgStart.length, 0x04),
    ]);
    const gpgExport = Buffer.concat([gpgPacket, Buffer.alloc(478 - gpgPacket.length, 0x04)]);
    await expectOutcomes(PRIVATE_KEY, [
      ["pgp-binary", gpgPacket],
      ["key-backup.gpg", gpgExport],
      ["photo.jpg", gpgExport],
      ["old-two-octet", packet([0x95, 0x05, 0x58], 0x558)],
      ["old-four-octet", packet([0x96, 0x00, 0x00, 0x01, 0x00], 256)],
      ["new-one-octet", packet([0xc5, 0x58], 0x58)],
      ["new-two-octet-low", packet([0xc5, 0xc0, 0x00], 192)],
      ["new-two-octet-high", packet([0xc5, 0xdf, 0xff], 8383)],
      ["new-five-octet", packet([0xc5, 0xff, 0x00, 0x00, 0x01, 0x00], 256)],
      ["subkey-split", packet([0x9c, 0x5d], 0x5d)],
      ["subkey-old-two-octet", packet([0x9d, 0x01, 0x00], 256)],
      ["subkey-old-four-octet", packet([0x9e, 0x00, 0x00, 0x01, 0x00], 256)],
      ["subkey-new", packet([0xc7, 0x58], 0x58)],
      ["old-version-2", packet([0x94, 0x58], 0x58, 2)],
      ["old-version-6", packet([0x94, 0x58], 0x58, 6)],
      ["new-version-2", packet([0xc5, 0x58], 0x58, 2)],
      ["new-version-6", packet([0xc5, 0x58], 0x58, 6)],
      ["smallest-body", packet([0x94, 0x28], 40)],
    ]);
  });

  it("a private key in base64, wherever it starts in a 3-byte group", LIMIT, async () => {
    const kubeconfig = `apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: ${base64(CERTIFICATE)}
    server: https://127.0.0.1:6443
  name: local
users:
- name: admin
  user:
    client-certificate-data: ${base64(CERTIFICATE)}
    client-key-data: ${base64(RSA_KEY)}
`;
    await expectOutcomes(PRIVATE_KEY, [
      // The marker at byte 15, 19 and 11: offset 0, 1 and 2 in its group.
      ["aligned.txt", base64("-----BEGIN RSA PRIVATE KEY-----\n")],
      ["skip-two.txt", base64("-----BEGIN OPENSSH PRIVATE KEY-----\n")],
      ["skip-one.txt", base64("-----BEGIN PRIVATE KEY-----\n")],
      ["kubeconfig.yaml", kubeconfig],
    ]);
  });

  it("links named like a key or a dotfile, and a plain link to a key", LIMIT, async () => {
    await symlink(join(work, "ok.txt"), join(work, "id_rsa"));
    await symlink(join(work, "ok.txt"), join(work, ".x"));
    await symlink(join(work, "server.pem"), join(work, "notes.txt"));
    assert.equal(reasonOf(await read(join(work, "id_rsa"))), KEY);
    assert.equal(reasonOf(await read(join(work, ".x"))), DOT);
    assert.equal(reasonOf(await read(join(work, "notes.txt"))), KEY);
  });

  it("a folder and a FIFO", LIMIT, async () => {
    const fifo = join(work, "pipe");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    assert.equal(reasonOf(await read(join(work, "dir"))), NOT_FILE);
    assert.equal(reasonOf(await read(fifo)), NOT_FILE);
  });

  it("a file over what is left of the budget", LIMIT, async () => {
    assert.equal(
      reasonOf(await read(join(work, "ok.txt"), [work], { remaining: 7 })),
      "would bring this upload over 10 MB, the most Foxleash uploads in one call.",
    );
  });

  it("a missing path as missing inside a folder and as outside elsewhere", LIMIT, async () => {
    assert.equal(reasonOf(await read(join(work, "gone.txt"))), MISSING);
    assert.equal(reasonOf(await read(join(work, "ok.txt", "below"))), MISSING);
    assert.equal(
      reasonOf(await read(join(root, "missing", "gone.txt"), [join(root, "missing")])),
      MISSING,
    );
    assert.match(reasonOf(await read(join(outside, "gone.txt"))), /^is outside the upload folders/);
    assert.equal(reasonOf(await read(join(work, ".ssh", "gone.txt"))), DOT);
  });

  it("a missing path behind a link inside by where the link leads", LIMIT, async () => {
    await symlink(outside, join(work, "out-dir"));
    await symlink(join(work, ".hidden"), join(work, "hidden-dir"));
    for (const requested of [
      join(work, "out-dir", "gone.txt"),
      join(work, "out-dir", "gone", "deeper.txt"),
    ]) {
      assert.match(reasonOf(await read(requested)), /^is outside the upload folders/, requested);
    }
    assert.equal(reasonOf(await read(join(work, "hidden-dir", "gone.txt"))), DOT);
    assert.equal(reasonOf(await read("/fh-missing-root/gone.txt", ["/fh-missing-root"])), MISSING);
  });

  it("a path it cannot resolve inside a folder as unreadable", LIMIT, async () => {
    await symlink("loop.txt", join(work, "loop.txt"));
    assert.equal(reasonOf(await read(join(work, "loop.txt"))), UNREADABLE);
  });

  it("a NUL in the path, and a relative path with no cwd", LIMIT, async () => {
    assert.equal(
      reasonOf(await read(`${work}/ok.txt\0`)),
      "contains a NUL character; give a path without one.",
    );
    assert.equal(
      reasonOf(await read("ok.txt", [work], { cwd: undefined })),
      "is a relative path, and the folder Foxleash was started in no longer exists; give an absolute path.",
    );
  });
});

describe("readAllowedFile before it opens", () => {
  it(
    "refuses without opening an outside file, a device, a FIFO, a folder or a key",
    LIMIT,
    async () => {
      const fifo = join(work, "pipe-2");
      assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
      await symlink("/dev/null", join(work, "null-link"));
      const opened: string[] = [];
      const seam = async (file: string, flags: number): Promise<ReadHandle> => {
        opened.push(file);
        return open(file, flags);
      };
      for (const requested of [
        join(outside, "x.txt"),
        join(work, "null-link"),
        fifo,
        join(work, "dir"),
        join(work, "server.pem"),
        join(work, "gone.txt"),
      ]) {
        assert.equal((await read(requested, [work], { open: seam })).ok, false, requested);
      }
      assert.deepEqual(opened, []);
      assert.equal((await read(join(work, "ok.txt"), [work], { open: seam })).ok, true);
      assert.deepEqual(opened, [join(work, "ok.txt")]);
    },
  );

  it("opens read-only, without a controlling terminal and without blocking", LIMIT, async () => {
    const flags: number[] = [];
    await read(join(work, "ok.txt"), [work], {
      open: (file, given) => {
        flags.push(given);
        return open(file, given);
      },
    });
    assert.deepEqual(flags, [FLAGS]);
  });
});

describe("readAllowedFile on the open descriptor", () => {
  it(
    "refuses a link swapped after the check to outside, a key, a dot folder or a file holding a key",
    LIMIT,
    async () => {
      const link = join(work, "swap.txt");
      for (const [target, reason] of [
        [join(outside, "x.txt"), /^is outside the upload folders/],
        [join(work, "server.pem"), new RegExp(`^${literal(KEY)}$`)],
        [join(work, ".hidden", "x.txt"), new RegExp(`^${literal(DOT)}$`)],
        [join(work, "plain-key.txt"), new RegExp(`^${literal(PRIVATE_KEY)}$`)],
      ] as const) {
        await rm(link, { force: true });
        await symlink(join(work, "ok.txt"), link);
        const result = await read(link, [work], {
          open: async (file, flags) => {
            await unlink(link);
            await symlink(target, link);
            return open(file, flags);
          },
        });
        assert.match(reasonOf(result), reason, target);
      }
    },
  );

  it("refuses a FIFO swapped in after the check without hanging", LIMIT, async () => {
    const swapped = join(work, "swapped.txt");
    await writeFile(swapped, "plain");
    let release: (() => Promise<void>) | undefined;
    const reading = read(swapped, [work], {
      open: async (file, flags) => {
        await unlink(swapped);
        assert.equal(spawnSync("mkfifo", [swapped]).status, 0);
        release = async () => {
          // O_RDWR on a FIFO never blocks on Linux, and gives a blocked reader its writer.
          await (await open(swapped, constants.O_RDWR | constants.O_NONBLOCK)).close();
        };
        return open(file, flags);
      },
    });
    const { promise: timeout, resolve } = Promise.withResolvers<"timeout">();
    const timer = setTimeout(() => resolve("timeout"), 2000);
    const first = await Promise.race([reading, timeout]);
    clearTimeout(timer);
    if (first === "timeout") {
      await release?.();
      await reading;
      assert.fail("opening the FIFO blocked");
    }
    assert.equal(reasonOf(first), NOT_FILE);
  });

  it("refuses a file deleted after it was opened", LIMIT, async () => {
    const doomed = join(work, "doomed.pem");
    await writeFile(doomed, "-----BEGIN PRIVATE KEY-----");
    const result = await read(join(work, "ok.txt"), [work], {
      open: async (_file, flags) => {
        const handle = await open(doomed, flags);
        await unlink(doomed);
        return handle;
      },
    });
    assert.equal(reasonOf(result), CHANGED);
  });

  it(
    "refuses a file holding a key by the bytes of the descriptor, not the path",
    LIMIT,
    async () => {
      const result = await read(join(work, "ok.txt"), [work], {
        open: (_file, flags) => open(join(work, "plain-key.txt"), flags),
      });
      assert.equal(reasonOf(result), PRIVATE_KEY);
    },
  );

  it("refuses a file that grew or shrank while it was read", LIMIT, async () => {
    for (const [file, change] of [
      ["ok.txt", 1],
      ["ok.txt", -1],
      ["plain-key.txt", 1],
      ["plain-key.txt", -1],
    ] as const) {
      const result = await read(join(work, file), [work], {
        open: async (file, flags) => {
          const handle = await open(file, flags);
          return {
            fd: handle.fd,
            stat: async () => {
              const info = await handle.stat();
              return { ...info, isFile: () => info.isFile(), size: info.size + change };
            },
            read: (buffer, offset, length, position) =>
              handle.read(buffer, offset, length, position),
            close: () => handle.close(),
          };
        },
      });
      assert.equal(reasonOf(result), CHANGED, `${file} ${change}`);
    }
  });

  it(
    "refuses a file that fails after the open as unreadable, without throwing",
    LIMIT,
    async () => {
      const result = await read(join(work, "ok.txt"), [work], {
        open: async (file, flags) => {
          const handle = await open(file, flags);
          return {
            fd: handle.fd,
            stat: () => handle.stat(),
            read: () => Promise.reject(Object.assign(new Error("read failed"), { code: "EIO" })),
            close: () => handle.close(),
          };
        },
      });
      assert.equal(reasonOf(result), UNREADABLE);
    },
  );

  it("refuses an open that fails, by its error", LIMIT, async () => {
    for (const [code, reason] of [
      ["ENOENT", MISSING],
      ["ENOTDIR", MISSING],
      ["EACCES", UNREADABLE],
    ] as const) {
      const result = await read(join(work, "ok.txt"), [work], {
        open: () => Promise.reject(Object.assign(new Error("open failed"), { code })),
      });
      assert.equal(reasonOf(result), reason, code);
    }
  });
});

describe("readAllowedFile by the file's age", () => {
  /** A real handle on ok.txt whose stat gives these times, in ms since the epoch. */
  function dated(times: { mtimeMs: number; ctimeMs: number; birthtimeMs: number }) {
    return async (file: string, flags: number): Promise<ReadHandle> => {
      const handle = await open(file, flags);
      return {
        fd: handle.fd,
        stat: async () => {
          const info = await handle.stat();
          return {
            isFile: () => info.isFile(),
            nlink: info.nlink,
            size: info.size,
            ...times,
          };
        },
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: () => handle.close(),
      };
    };
  }

  const NOW = 1_800_000_000_000;
  const OLD = NOW - 60_000;

  it(
    "refuses a file when any of its three times is less than FRESH_FILE_MS old",
    LIMIT,
    async () => {
      for (const name of ["mtimeMs", "ctimeMs", "birthtimeMs"] as const) {
        const times = {
          mtimeMs: OLD,
          ctimeMs: OLD,
          birthtimeMs: OLD,
          [name]: NOW - FRESH_FILE_MS + 1,
        };
        const result = await read(join(work, "ok.txt"), [work], {
          open: dated(times),
          now: () => NOW,
        });
        assert.equal(reasonOf(result), FRESH, name);
      }
    },
  );

  it("reads a file whose newest time is exactly FRESH_FILE_MS old", LIMIT, async () => {
    for (const name of ["mtimeMs", "ctimeMs", "birthtimeMs"] as const) {
      const times = { mtimeMs: OLD, ctimeMs: OLD, birthtimeMs: OLD, [name]: NOW - FRESH_FILE_MS };
      const result = await read(join(work, "ok.txt"), [work], {
        open: dated(times),
        now: () => NOW,
      });
      assert.equal(result.ok, true, name);
    }
  });

  it(
    "reads a file whose modified time is ahead of the clock once its other times are old",
    LIMIT,
    async () => {
      for (const [mtimeMs, ctimeMs, ok] of [
        [NOW + 3_600_000, OLD, true],
        [NOW + 3_600_000, NOW - FRESH_FILE_MS + 1, false],
        // Not ahead: it counts.
        [NOW, OLD, false],
      ] as const) {
        const result = await read(join(work, "ok.txt"), [work], {
          open: dated({ mtimeMs, ctimeMs, birthtimeMs: OLD }),
          now: () => NOW,
        });
        assert.equal(result.ok, ok, `${mtimeMs} ${ctimeMs}`);
      }
    },
  );

  it("reads an old file, and one on a file system with no birth time", LIMIT, async () => {
    for (const birthtimeMs of [OLD, 0]) {
      const result = await read(join(work, "ok.txt"), [work], {
        open: dated({ mtimeMs: OLD, ctimeMs: OLD, birthtimeMs }),
        now: () => NOW,
      });
      assert.deepEqual(result.ok && result.bytes, Buffer.from("ok bytes"), String(birthtimeMs));
    }
  });

  it("refuses a file just written, and reads it once it is FRESH_FILE_MS old", LIMIT, async () => {
    const file = join(work, "fresh.txt");
    await writeFile(file, "fresh bytes");
    const info = await stat(file);
    const written = Math.max(info.mtimeMs, info.ctimeMs, info.birthtimeMs);
    assert.equal(reasonOf(await read(file, [work], { now: () => written })), FRESH);
    const later = await read(file, [work], { now: () => written + FRESH_FILE_MS });
    assert.deepEqual(later.ok && later.bytes, Buffer.from("fresh bytes"));
  });

  it("reads the time from Date.now when given no clock", LIMIT, async () => {
    const file = join(work, "fresh-now.txt");
    await writeFile(file, "fresh bytes");
    const result = await readAllowedFile(file, [work], { cwd: work, home, remaining: BUDGET });
    assert.equal(reasonOf(result), FRESH);
  });
});

describe("fileType", () => {
  it("names the MIME type of known extensions, in any case", () => {
    const expected: Record<string, string> = {
      "a.pdf": "application/pdf",
      "a.png": "image/png",
      "a.jpg": "image/jpeg",
      "a.JPEG": "image/jpeg",
      "a.gif": "image/gif",
      "a.webp": "image/webp",
      "a.svg": "image/svg+xml",
      "a.txt": "text/plain",
      "a.csv": "text/csv",
      "a.json": "application/json",
      "a.html": "text/html",
      "a.htm": "text/html",
      "a.zip": "application/zip",
      "a.doc": "application/msword",
      "a.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "a.xls": "application/vnd.ms-excel",
      "a.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "a.mp3": "audio/mpeg",
      "a.MP4": "video/mp4",
    };
    for (const [name, type] of Object.entries(expected)) assert.equal(fileType(name), type, name);
  });

  it("is empty for other extensions and for none", () => {
    for (const name of ["a.exe", "README", "archive.tar.gz", "a.", "a.constructor"]) {
      assert.equal(fileType(name), "", name);
    }
  });
});

function read(
  requested: string,
  folders: readonly string[] = [work],
  ctx: Partial<ReadContext> = {},
): Promise<ReadResult> {
  // Files a test writes are read at once: the clock runs ahead unless a test sets it. Not by
  // FRESH_FILE_MS alone: a file's times carry fractions of the millisecond Date.now rounds down.
  return readAllowedFile(requested, folders, {
    cwd: work,
    home,
    remaining: BUDGET,
    now: () => Date.now() + 2 * FRESH_FILE_MS,
    ...ctx,
  });
}

let configs = 0;

/** A fresh config folder holding `text` as its user-dirs.dirs, as the env that names it. */
async function userDirs(text: string): Promise<{ XDG_CONFIG_HOME: string }> {
  configs += 1;
  const config = join(root, `config-${configs}`);
  await mkdir(config);
  await writeFile(join(config, "user-dirs.dirs"), text);
  return { XDG_CONFIG_HOME: config };
}

/** The upload folders with the working folder `work`, in the shared home, for a user-dirs.dirs. */
async function downloadFolders(text: string): Promise<string[]> {
  return uploadFolders({ env: await userDirs(text), cwd: work, home }).folders;
}

/** Writes each file into `work` and compares every outcome at once, so the diff names each miss. */
async function expectOutcomes(
  expected: string,
  files: readonly (readonly [string, string | Buffer])[],
): Promise<void> {
  const outcomes: string[] = [];
  for (const [name, content] of files) {
    await writeFile(join(work, name), content);
    const result = await read(join(work, name));
    outcomes.push(`${name}: ${result.ok ? "accepted" : result.reason}`);
  }
  assert.deepEqual(
    outcomes,
    files.map(([name]) => `${name}: ${expected}`),
  );
}

function reasonOf(result: ReadResult): string {
  assert.ok(!result.ok, `accepted ${result.ok ? result.path : ""}`);
  return result.reason;
}

/**
 * An OpenPGP packet: `header`, then a body of `length` bytes that starts with the key version.
 * Every other body byte is 4 too, so a parse that reads the version from the wrong place matches.
 */
function packet(header: readonly number[], length: number, version = 4): Buffer {
  return Buffer.concat([
    Buffer.from(header),
    Buffer.from([version]),
    Buffer.alloc(length - 1, 0x04),
  ]);
}

/** Reads at most three bytes at a time. */
function shortReads(handle: ReadHandle): ReadHandle {
  return {
    fd: handle.fd,
    stat: () => handle.stat(),
    read: (buffer, offset, length, position) =>
      handle.read(buffer, offset, Math.min(length, 3), position),
    close: () => handle.close(),
  };
}

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function base64(text: string): string {
  return Buffer.from(text).toString("base64");
}
