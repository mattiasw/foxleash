import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type Firefox, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { type FixtureServer, startFixtureServer, TITLES } from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  parseResult,
  type Session,
  tabOf,
  tabsOf,
  untrustedContent,
  withoutAfter,
} from "./harness.ts";

const REF = "([a-z]{1,7}[1-9][0-9]*)";
// What the page got: per target the name, size, type and SHA-256 of each file, and its events.
const RECEIVED = `(async () => {
  const hex = async (file) => Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const files = {};
  for (const [target, list] of Object.entries(window.received)) {
    files[target] = await Promise.all(list.map(async (file) =>
      ({ name: file.name, size: file.size, type: file.type, sha256: await hex(file) })));
  }
  return JSON.stringify({ files, events: window.events });
})()`;

interface PageFile {
  name: string;
  size: number;
  type: string;
  sha256: string;
}

interface Received {
  files: Record<"single" | "many" | "unnamed" | "typed" | "zone", PageFile[]>;
  events: Record<"single" | "many" | "unnamed" | "typed" | "zone", string[]> & {
    documentDrops: number;
  };
}

// One Firefox for the file: the tests run in order on one page.
describe("upload_file in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let outer = "";
  let allowed = "";
  let tabId = -1;
  let context = "";
  const refs = { single: "", many: "", unnamed: "", typed: "", zone: "", plain: "" };
  const big = randomBytes(1_500_000);

  before(
    async () => {
      outer = await realpath(await mkdtemp(join(tmpdir(), "fh-upload-")));
      allowed = join(outer, "allowed");
      await mkdir(allowed);
      await writeFile(join(allowed, "big.bin"), big);
      await writeFile(join(allowed, "notes.txt"), "notes");
      await writeFile(join(allowed, "photo.png"), "not really a png");
      await writeFile(join(allowed, ".secret"), "secret");
      await writeFile(join(outer, "outside.txt"), "outside");
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
      session = await harness.connect({ FOXLEASH_UPLOAD_DIRS: allowed });
      await harness.waitUntilReady(session);
      const tab = tabOf(await harness.ok(session, "tab_open", { url: fixtures.url("/upload") }));
      assert.equal(tab.title, TITLES.upload);
      tabId = tab.id;
      const found = (await firefox.contexts()).find(({ url }) => url === fixtures.url("/upload"));
      assert.ok(found !== undefined, "no tab shows the upload page");
      context = found.context;
      const read = await harness.call(session, "read_page", { tabId });
      assert.equal(read.isError, false, read.text);
      const tree = untrustedContent(read.text) ?? "";
      for (const [key, pattern] of [
        ["single", new RegExp(`^ *button "Single file" \\[${REF}\\] file field$`, "m")],
        ["many", new RegExp(`^ *button "Many files" \\[${REF}\\] file field$`, "m")],
        ["unnamed", new RegExp(`^ *button \\[${REF}\\] file field$`, "m")],
        ["typed", new RegExp(`^ *textbox "Typed file" \\[${REF}\\] file field$`, "m")],
        ["zone", new RegExp(`^ *region "Drop zone" \\[${REF}\\]$`, "m")],
        ["plain", new RegExp(`^ *button "No drops" \\[${REF}\\]$`, "m")],
      ] as const) {
        const ref = pattern.exec(tree)?.[1];
        assert.ok(ref !== undefined, `no ref for ${pattern} in:\n${tree}`);
        refs[key] = ref;
      }
      assert.equal(tree.match(/ file field$/gm)?.length, 4, tree);
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      try {
        await harness?.close();
      } finally {
        try {
          await fixtures?.close();
        } finally {
          if (outer !== "") await rm(outer, { recursive: true, force: true });
        }
      }
    },
    { timeout: 60_000 },
  );

  test("a file over 1 MB reaches a file field byte for byte, with input and change", async () => {
    const result = await upload(refs.single, [join(allowed, "big.bin")]);
    assert.equal(result.isError, false, result.text);
    const [, framed, ...rest] = result.texts;
    assert.deepEqual(rest, []);
    assert.deepEqual(withoutAfter(parseResult(framed ?? "")), {});
    assert.equal(
      result.text,
      `Put 1 file into the file field ${refs.single} in tab ${tabId}:\n- ${JSON.stringify(join(allowed, "big.bin"))}, 1,500,000 bytes`,
    );
    const page = await received();
    assert.deepEqual(page.files.single, [
      { name: "big.bin", size: big.length, type: "", sha256: sha256(big) },
    ]);
    assert.deepEqual(page.events.single, ["input", "change"]);
  });

  test("several files go into a field that takes several", async () => {
    const result = await upload(
      refs.many,
      ["notes.txt", "photo.png"].map((name) => join(allowed, name)),
    );
    assert.equal(result.isError, false, result.text);
    const page = await received();
    assert.deepEqual(page.files.many, [
      { name: "notes.txt", size: 5, type: "text/plain", sha256: sha256("notes") },
      { name: "photo.png", size: 16, type: "image/png", sha256: sha256("not really a png") },
    ]);
    assert.deepEqual(page.events.many, ["input", "change"]);
  });

  test("a file field with no label is found by its line and gets the file", async () => {
    const result = await upload(refs.unnamed, [join(allowed, "notes.txt")]);
    assert.equal(result.isError, false, result.text);
    assert.equal(
      result.text,
      `Put 1 file into the file field ${refs.unnamed} in tab ${tabId}:\n- ${JSON.stringify(join(allowed, "notes.txt"))}, 5 bytes`,
    );
    const page = await received();
    assert.deepEqual(page.files.unnamed, [
      { name: "notes.txt", size: 5, type: "text/plain", sha256: sha256("notes") },
    ]);
    assert.deepEqual(page.events.unnamed, ["input", "change"]);
  });

  test("a file field with a text box role never shows the chosen file's name", async () => {
    const result = await upload(refs.typed, [join(allowed, "notes.txt")]);
    assert.equal(result.isError, false, result.text);
    const page = await received();
    assert.deepEqual(page.files.typed, [
      { name: "notes.txt", size: 5, type: "text/plain", sha256: sha256("notes") },
    ]);
    assert.deepEqual(page.events.typed, ["input", "change"]);
    const read = await harness.call(session, "read_page", { tabId });
    assert.equal(read.isError, false, read.text);
    const tree = untrustedContent(read.text) ?? "";
    assert.match(tree, new RegExp(`^ *textbox "Typed file" \\[${refs.typed}\\] file field$`, "m"));
    for (const leaked of ["fakepath", "notes.txt", "photo.png", "big.bin"]) {
      assert.equal(tree.includes(leaked), false, `${leaked} in:\n${tree}`);
    }
  });

  test("a field that takes one file refuses two", async () => {
    const text = await harness.refused(session, "upload_file", {
      tabId,
      ref: refs.single,
      paths: [join(allowed, "notes.txt"), join(allowed, "photo.png")],
    });
    assert.ok(text.includes("That file field takes one file, and 2 were given."), text);
    assert.deepEqual((await received()).events.single, ["input", "change"]);
  });

  test("a drop zone gets the files dropped on it", async () => {
    const result = await upload(refs.zone, [join(allowed, "notes.txt"), join(allowed, "big.bin")]);
    assert.equal(result.isError, false, result.text);
    assert.ok(
      result.text.startsWith(`Dropped 2 files on ${refs.zone} in tab ${tabId}:`),
      result.text,
    );
    const page = await received();
    assert.deepEqual(page.files.zone, [
      { name: "notes.txt", size: 5, type: "text/plain", sha256: sha256("notes") },
      { name: "big.bin", size: big.length, type: "", sha256: sha256(big) },
    ]);
    assert.deepEqual(page.events.zone, ["drop"]);
  });

  test("an element that takes no drops is refused, and sees no drop", async () => {
    const before = await received();
    const text = await harness.refused(session, "upload_file", {
      tabId,
      ref: refs.plain,
      paths: [join(allowed, "notes.txt")],
    });
    assert.ok(
      text.includes("That element is neither a file field nor a place that takes dropped files."),
      text,
    );
    assert.deepEqual(await received(), before);
    assert.equal(before.events.documentDrops, 1);
  });

  test("a dotfile and a file outside the folder are refused, and the page gets nothing", async () => {
    const before = await received();
    const dot = await harness.refused(session, "upload_file", {
      tabId,
      ref: refs.many,
      paths: [join(allowed, "notes.txt"), join(allowed, ".secret")],
    });
    assert.ok(dot.startsWith("Foxleash uploaded nothing: "), dot);
    assert.ok(dot.includes("starting with a dot"), dot);
    const out = await harness.refused(session, "upload_file", {
      tabId,
      ref: refs.many,
      paths: [join(outer, "outside.txt")],
    });
    assert.ok(out.includes(`is outside the upload folders (${allowed})`), out);
    assert.deepEqual(await received(), before);
  });

  test("a tab on a site the user has not approved is refused without asking", async () => {
    const tab = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/read-redirect") }),
    );
    const other = `http://localhost:${fixtures.port}`;
    // tab_open can return before the tab shows the redirect target.
    await pollUntil(
      async () => {
        const listed = tabsOf(await harness.ok(session, "tabs_list")).find(
          ({ id }) => id === tab.id,
        );
        if (listed !== undefined && URL.parse(listed.url)?.origin === other) return listed;
        throw new Error(`tab ${tab.id} is listed as ${JSON.stringify(listed?.url)}`);
      },
      PAGE_TIMEOUT_MS,
      `tab ${tab.id} to show ${other}`,
    );
    const before = (await firefox.contexts()).length;
    const text = await harness.refused(session, "upload_file", {
      tabId: tab.id,
      ref: refs.single,
      paths: [join(allowed, "notes.txt")],
    });
    assert.ok(text.includes(`Foxleash is not allowed on ${other} in this session`), text);
    const prompt = firefox.extensionUrl("approve.html");
    const contexts = await firefox.contexts();
    assert.equal(contexts.length, before);
    assert.equal(
      contexts.some(({ url }) => url.startsWith(prompt)),
      false,
      JSON.stringify(contexts),
    );
  });

  function upload(ref: string, paths: string[]) {
    return harness.call(session, "upload_file", { tabId, ref, paths });
  }

  async function received(): Promise<Received> {
    return JSON.parse(String(await firefox.evaluate(context, RECEIVED)));
  }
});

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
