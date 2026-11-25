import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { FRESH_FILE_MS } from "../apps/server/src/upload-policy.ts";
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
  files: Record<
    | "single"
    | "many"
    | "unnamed"
    | "typed"
    | "zone"
    | "compose"
    | "late"
    | "attach"
    | "picker"
    | "forged"
    | "forgedText",
    PageFile[]
  >;
  events: Record<
    | "single"
    | "many"
    | "unnamed"
    | "typed"
    | "zone"
    | "compose"
    | "late"
    | "notaken"
    | "attach"
    | "picker"
    | "forged"
    | "forgedText",
    string[]
  > & {
    documentDrops: number;
  };
}

interface PageWideReceived {
  files: Record<"zone" | "stopping", PageFile[]>;
  events: Record<"plain" | "zone" | "stopping", string[]> & { windowDrops: number };
}

const DROP_NOTE =
  "The page decides what to do with dropped files; read the page to check that it took them.";
const PAGE_WIDE_DROP_NOTE =
  "Pages often take drops anywhere on the page only to keep Firefox from opening the files, so read the page to check that it took them. If it did not, do not drop them there again: give upload_file the ref of a file field, or of the button that opens the page's file picker.";

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
  const refs = {
    single: "",
    many: "",
    unnamed: "",
    typed: "",
    zone: "",
    plain: "",
    body: "",
    late: "",
    notaken: "",
    attach: "",
    picker: "",
    nopicker: "",
    forged: "",
    forgedText: "",
    send: "",
    leave: "",
  };
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
        ["plain", new RegExp(`^ *region "No drops" \\[${REF}\\]$`, "m")],
        ["body", new RegExp(`^ *textbox "Message body" \\[${REF}\\]`, "m")],
        ["late", new RegExp(`^ *region "Late drop area" \\[${REF}\\]$`, "m")],
        ["notaken", new RegExp(`^ *region "Not taken" \\[${REF}\\]$`, "m")],
        ["attach", new RegExp(`^ *button "Attach files" \\[${REF}\\]$`, "m")],
        ["picker", new RegExp(`^ *button "Show picker" \\[${REF}\\]$`, "m")],
        ["nopicker", new RegExp(`^ *button "No picker" \\[${REF}\\]$`, "m")],
        ["forged", new RegExp(`^ *button "Forged picker" \\[${REF}\\]$`, "m")],
        ["forgedText", new RegExp(`^ *button "Forged text field" \\[${REF}\\]$`, "m")],
        ["send", new RegExp(`^ *button "Send form" \\[${REF}\\]$`, "m")],
        ["leave", new RegExp(`^ *link "Leave this page" \\[${REF}\\]`, "m")],
      ] as const) {
        const ref = pattern.exec(tree)?.[1];
        assert.ok(ref !== undefined, `no ref for ${pattern} in:\n${tree}`);
        refs[key] = ref;
      }
      assert.equal(tree.match(/ file field$/gm)?.length, 4, tree);
      // upload_file refuses a file saved or changed in the last FRESH_FILE_MS.
      const written = await Promise.all(
        [
          join(allowed, "big.bin"),
          join(allowed, "notes.txt"),
          join(allowed, "photo.png"),
          join(allowed, ".secret"),
          join(outer, "outside.txt"),
        ].map(async (file) => {
          const info = await stat(file);
          return Math.max(info.mtimeMs, info.ctimeMs, info.birthtimeMs);
        }),
      );
      // Rounded up: a file's times carry fractions of the millisecond.
      const wait = Math.ceil(Math.max(...written) + FRESH_FILE_MS - Date.now());
      if (wait > 0) await sleep(wait);
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
    // Without the view, so the result is the note and the act's after alone.
    const result = await upload(refs.single, [join(allowed, "big.bin")], { view: false });
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

  test("a drop on a compose window's body lands on the drop area the window shows", async () => {
    const result = await upload(refs.body, [join(allowed, "notes.txt"), join(allowed, "big.bin")]);
    assert.equal(result.isError, false, result.text);
    assert.ok(
      result.text.startsWith(`Dropped 2 files on ${refs.body} in tab ${tabId}:`),
      result.text,
    );
    const page = await received();
    assert.deepEqual(page.files.compose, [
      { name: "notes.txt", size: 5, type: "text/plain", sha256: sha256("notes") },
      { name: "big.bin", size: big.length, type: "", sha256: sha256(big) },
    ]);
    assert.deepEqual(page.events.compose, [
      "dragenter body",
      "dragenter overlay",
      "dragleave body",
      "dragover overlay",
      "dragover overlay",
      "drop overlay",
    ]);
    const { point, box } = JSON.parse(
      String(
        await firefox.evaluate(
          context,
          `JSON.stringify({ point: window.dropPoint, box: document.getElementById("body").getBoundingClientRect() })`,
        ),
      ),
    );
    assert.ok(
      point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom,
      JSON.stringify({ point, box }),
    );
  });

  test("a drop area the page shows after the first dragover gets the drop", async () => {
    const result = await upload(refs.late, [join(allowed, "photo.png")]);
    assert.equal(result.isError, false, result.text);
    const page = await received();
    assert.deepEqual(page.files.late, [
      { name: "photo.png", size: 16, type: "image/png", sha256: sha256("not really a png") },
    ]);
    assert.deepEqual(page.events.late, ["drop"]);
  });

  test("a place that takes the drag but not the dropped files is refused", async () => {
    const text = await harness.refused(session, "upload_file", {
      tabId,
      ref: refs.notaken,
      paths: [join(allowed, "notes.txt")],
    });
    assert.ok(
      text.includes(
        "The page showed that it takes a drag there but did not take the dropped files. Give upload_file the ref of a file field, or of the button that opens the page's file picker.",
      ),
      text,
    );
    assert.deepEqual((await received()).events.notaken, ["drop"]);
  });

  test("a button whose page opens a file field it never adds gets the files into that field", async () => {
    const result = await upload(refs.attach, [
      join(allowed, "notes.txt"),
      join(allowed, "big.bin"),
    ]);
    assert.equal(result.isError, false, result.text);
    assert.ok(
      result.text.startsWith(
        `Clicked ${refs.attach} in tab ${tabId} and put 2 files into the file field the page opened:`,
      ),
      result.text,
    );
    const page = await received();
    assert.deepEqual(page.files.attach, [
      { name: "notes.txt", size: 5, type: "text/plain", sha256: sha256("notes") },
      { name: "big.bin", size: big.length, type: "", sha256: sha256(big) },
    ]);
    assert.deepEqual(page.events.attach, ["input", "change"]);
    assert.equal(
      await firefox.evaluate(
        context,
        `[Object.getOwnPropertyDescriptor(HTMLElement.prototype, "click").value, Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "showPicker").value].every((method) => String(method).includes("[native code]"))`,
      ),
      true,
    );
  });

  test("a button whose page asks a hidden file field for its picker later gets the file into it", async () => {
    const result = await upload(refs.picker, [join(allowed, "photo.png")]);
    assert.equal(result.isError, false, result.text);
    assert.ok(
      result.text.startsWith(
        `Clicked ${refs.picker} in tab ${tabId} and put 1 file into the file field the page opened:`,
      ),
      result.text,
    );
    const page = await received();
    assert.deepEqual(page.files.picker, [
      { name: "photo.png", size: 16, type: "image/png", sha256: sha256("not really a png") },
    ]);
    assert.deepEqual(page.events.picker, ["input", "change"]);
  });

  test("a button that opens no file picker is refused, saying it was clicked", async () => {
    const before = await received();
    const text = await harness.refused(session, "upload_file", {
      tabId,
      ref: refs.nopicker,
      paths: [join(allowed, "notes.txt")],
    });
    assert.ok(
      text.includes(
        `Foxleash clicked ${refs.nopicker}, but the page opened no file picker within 5 seconds`,
      ),
      text,
    );
    assert.deepEqual(await received(), before);
  });

  test("a file field of another document that the page hands over gets nothing", async () => {
    const text = await harness.refused(session, "upload_file", {
      tabId,
      ref: refs.forged,
      paths: [join(allowed, "notes.txt")],
    });
    assert.ok(
      text.includes(
        `Foxleash clicked ${refs.forged}, but the page opened no file picker within 5 seconds`,
      ),
      text,
    );
    const page = await received();
    assert.deepEqual(page.events.forged, []);
    assert.deepEqual(page.files.forged, []);
  });

  test("a text field that the page hands over as a file field gets nothing", async () => {
    const text = await harness.refused(session, "upload_file", {
      tabId,
      ref: refs.forgedText,
      paths: [join(allowed, "notes.txt")],
    });
    assert.ok(
      text.includes(
        `Foxleash clicked ${refs.forgedText}, but the page opened no file picker within 5 seconds`,
      ),
      text,
    );
    assert.deepEqual((await received()).events.forgedText, []);
  });

  test("a button that would send a protected field with GET is refused, and the page stays", async () => {
    const text = await harness.refused(session, "upload_file", {
      tabId,
      ref: refs.send,
      paths: [join(allowed, "notes.txt")],
    });
    assert.ok(text.includes("The form would put the value of protected field"), text);
    assert.equal(text.includes("pin-Q7xa"), false, text);
    const listed = tabsOf(await harness.ok(session, "tabs_list")).find(({ id }) => id === tabId);
    assert.equal(listed?.url, fixtures.url("/upload"));
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

  // Last on the upload tab: it leaves the page.
  test("a link that leads to another page says upload_file ran, not to try again", async () => {
    const text = await harness.refused(session, "upload_file", {
      tabId,
      ref: refs.leave,
      paths: [join(allowed, "notes.txt")],
    });
    assert.ok(text.includes("read the page before you repeat it"), text);
    assert.equal(text.includes("try again"), false, text);
  });

  // In a tab of its own, opened after the upload tab's tests: a tab in front slows the timers of
  // the upload tab.
  describe("a page that takes drops as a whole", () => {
    let wideTab = -1;
    let wideContext = "";
    const wide = { plain: "", zone: "", stopping: "" };
    const notes = () => JSON.stringify(join(allowed, "notes.txt"));
    const flagged = (ref: string) =>
      `Dropped 1 file on ${ref} in tab ${wideTab}, but Foxleash saw only a listener on the whole page take the drop:\n- ${notes()}, 5 bytes\n${PAGE_WIDE_DROP_NOTE}`;

    before(async () => {
      const url = fixtures.url("/upload-page-wide");
      const tab = tabOf(await harness.ok(session, "tab_open", { url }));
      assert.equal(tab.title, TITLES.uploadPageWide);
      wideTab = tab.id;
      const found = (await firefox.contexts()).find((each) => each.url === url);
      assert.ok(found !== undefined, `no tab shows ${url}`);
      wideContext = found.context;
      const read = await harness.call(session, "read_page", { tabId: wideTab });
      assert.equal(read.isError, false, read.text);
      const tree = untrustedContent(read.text) ?? "";
      for (const [key, name] of [
        ["plain", "Plain"],
        ["zone", "Own drop zone"],
        ["stopping", "Stopping drop zone"],
      ] as const) {
        const ref = new RegExp(`^ *region "${name}" \\[${REF}\\]$`, "m").exec(tree)?.[1];
        assert.ok(ref !== undefined, `no ref for region "${name}" in:\n${tree}`);
        wide[key] = ref;
      }
    });

    test("a plain region on a page that cancels drops as a whole says only the page took them", async () => {
      const before = await wideReceived();
      const result = await dropWide(wide.plain);
      assert.equal(result.isError, false, result.text);
      assert.equal(result.text, flagged(wide.plain));
      const page = await wideReceived();
      assert.deepEqual(page.events.plain, [...before.events.plain, "drop"]);
      assert.equal(page.events.windowDrops, before.events.windowDrops + 1);
    });

    test("an own drop zone on a page that cancels drops as a whole gets the plain drop result", async () => {
      const before = await wideReceived();
      const result = await dropWide(wide.zone);
      assert.equal(result.isError, false, result.text);
      assert.equal(
        result.text,
        `Dropped 1 file on ${wide.zone} in tab ${wideTab}:\n- ${notes()}, 5 bytes\n${DROP_NOTE}`,
      );
      const page = await wideReceived();
      assert.deepEqual(page.files.zone, [
        { name: "notes.txt", size: 5, type: "text/plain", sha256: sha256("notes") },
      ]);
      assert.deepEqual(page.events.zone, [...before.events.zone, "drop"]);
      assert.equal(page.events.windowDrops, before.events.windowDrops + 1);
    });

    test("a drop zone that stops the drop on a page that cancels drops as a whole gets the plain drop result", async () => {
      const before = await wideReceived();
      const result = await dropWide(wide.stopping);
      assert.equal(result.isError, false, result.text);
      assert.equal(
        result.text,
        `Dropped 1 file on ${wide.stopping} in tab ${wideTab}:\n- ${notes()}, 5 bytes\n${DROP_NOTE}`,
      );
      const page = await wideReceived();
      assert.deepEqual(page.files.stopping, [
        { name: "notes.txt", size: 5, type: "text/plain", sha256: sha256("notes") },
      ]);
      assert.deepEqual(page.events.stopping, [...before.events.stopping, "drop"]);
      assert.equal(page.events.windowDrops, before.events.windowDrops);
    });

    test("a plain region whose document cancels drops as a whole in the capture phase is flagged", async () => {
      await firefox.evaluate(wideContext, `window.cancelAt = "document"`);
      try {
        const before = await wideReceived();
        const result = await dropWide(wide.plain);
        assert.equal(result.isError, false, result.text);
        assert.equal(result.text, flagged(wide.plain));
        const page = await wideReceived();
        assert.deepEqual(page.events.plain, [...before.events.plain, "drop"]);
        assert.equal(page.events.windowDrops, before.events.windowDrops + 1);
      } finally {
        await firefox.evaluate(wideContext, `window.cancelAt = "window"`);
      }
    });

    test("an own drop zone whose document cancels drops as a whole in the capture phase is flagged, and gets the files", async () => {
      await firefox.evaluate(wideContext, `window.cancelAt = "document"`);
      try {
        await firefox.evaluate(wideContext, `void (window.received.zone = [])`);
        const before = await wideReceived();
        const result = await dropWide(wide.zone);
        assert.equal(result.isError, false, result.text);
        assert.equal(result.text, flagged(wide.zone));
        const page = await wideReceived();
        assert.deepEqual(page.files.zone, [
          { name: "notes.txt", size: 5, type: "text/plain", sha256: sha256("notes") },
        ]);
        assert.deepEqual(page.events.zone, [...before.events.zone, "drop"]);
      } finally {
        await firefox.evaluate(wideContext, `window.cancelAt = "window"`);
      }
    });

    test("a plain region whose window cancels and stops drops as a whole in the capture phase is flagged", async () => {
      await firefox.evaluate(wideContext, `window.cancelAt = "window-capture"`);
      try {
        const before = await wideReceived();
        const result = await dropWide(wide.plain);
        assert.equal(result.isError, false, result.text);
        assert.equal(result.text, flagged(wide.plain));
        const page = await wideReceived();
        assert.deepEqual(page.events.plain, before.events.plain);
        assert.equal(page.events.windowDrops, before.events.windowDrops);
      } finally {
        await firefox.evaluate(wideContext, `window.cancelAt = "window"`);
      }
    });

    function dropWide(ref: string) {
      return upload(ref, [join(allowed, "notes.txt")], { tabId: wideTab });
    }

    async function wideReceived(): Promise<PageWideReceived> {
      return JSON.parse(String(await firefox.evaluate(wideContext, RECEIVED)));
    }
  });

  // In a tab of its own, opened last: a tab in front slows the timers of the upload tab.
  test("a button in a page where no catcher answers is refused without a click", async () => {
    const url = fixtures.url("/upload-held");
    const tab = tabOf(await harness.ok(session, "tab_open", { url }));
    assert.equal(tab.title, TITLES.uploadHeld);
    const found = (await firefox.contexts()).find((each) => each.url === url);
    assert.ok(found !== undefined, `no tab shows ${url}`);
    const read = await harness.call(session, "read_page", { tabId: tab.id });
    assert.equal(read.isError, false, read.text);
    const tree = untrustedContent(read.text) ?? "";
    const ref = new RegExp(`^ *button "Attach held" \\[${REF}\\]$`, "m").exec(tree)?.[1];
    assert.ok(ref !== undefined, tree);
    const text = await harness.refused(session, "upload_file", {
      tabId: tab.id,
      ref,
      paths: [join(allowed, "notes.txt")],
    });
    assert.ok(
      text.includes(
        `Foxleash could not get ready to take the file picker ${ref} may open, so it did not click it`,
      ),
      text,
    );
    assert.equal(await firefox.evaluate(found.context, "window.clicks"), 0);
  });

  function upload(ref: string, paths: string[], args: Record<string, unknown> = {}) {
    return harness.call(session, "upload_file", { tabId, ref, paths, ...args });
  }

  async function received(): Promise<Received> {
    return JSON.parse(String(await firefox.evaluate(context, RECEIVED)));
  }
});

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
