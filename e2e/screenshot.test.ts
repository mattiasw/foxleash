import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { inflateSync } from "node:zlib";
import { SCREENSHOT_NOTE } from "../apps/server/src/tools.ts";
import type { Firefox } from "./firefox.ts";
import {
  type FixtureServer,
  SHOT_BOX,
  SHOT_COLOURS,
  startFixtureServer,
  TITLES,
} from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  type ToolResult,
  tabOf,
  tabsOf,
  untrustedContent,
} from "./harness.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BOX_REF = /button "Shot box" \[([0-9a-f]{8}-[1-9][0-9]*)\]/;
const VIEWPORT = "JSON.stringify([window.innerWidth, window.innerHeight])";
const SCROLL_AND_BOX = `JSON.stringify({
  scrollY: window.scrollY,
  box: document.getElementById("shot-box").getBoundingClientRect(),
  width: window.innerWidth,
  height: window.innerHeight,
})`;
// Per channel, for colour management and dithering.
const TOLERANCE = 2;

interface Png {
  width: number;
  height: number;
  channels: number;
  /** Unfiltered rows, `width * channels` bytes each. */
  pixels: Buffer;
}

// One Firefox for the file: the tests run in order and build on each other's tabs.
describe("screenshot in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let outer = "";
  let work = "";
  let shotTab = -1;

  before(
    async () => {
      outer = await mkdtemp(join(tmpdir(), "fh-shot-"));
      work = join(outer, "work");
      await mkdir(work);
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
      session = await harness.connect();
      await harness.waitUntilReady(session);
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

  test("a viewport screenshot of a background tab shows that tab", async () => {
    shotTab = await open(session, "/shot", TITLES.shot);
    await open(session, "/a", TITLES.a);
    const tabs = tabsOf(await harness.ok(session, "tabs_list"));
    assert.equal(tabs.find((tab) => tab.id === shotTab)?.active, false, JSON.stringify(tabs));
    const context = await contextOf(fixtures.url("/shot"));
    const viewport = JSON.parse(String(await firefox.evaluate(context, VIEWPORT)));
    const result = await harness.call(session, "screenshot", { tabId: shotTab });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(result.texts, [SCREENSHOT_NOTE]);
    const png = onlyImage(result);
    assert.deepEqual([png.width, png.height], viewport);
    // Away from the box, which starts 1500 px down, and from any text.
    assertColour(png, 10, 10, SHOT_COLOURS.page);
    assertColour(png, Math.floor(png.width / 2), Math.floor(png.height / 2), SHOT_COLOURS.page);
  });

  test("an element screenshot scrolls the box into view and is exactly its box", async () => {
    const context = await contextOf(fixtures.url("/shot"));
    const beforeShot = JSON.parse(String(await firefox.evaluate(context, SCROLL_AND_BOX)));
    assert.equal(beforeShot.scrollY, 0);
    const read = await harness.call(session, "read_page", { tabId: shotTab });
    assert.equal(read.isError, false, read.text);
    const tree = untrustedContent(read.text) ?? "";
    const ref = BOX_REF.exec(tree)?.[1];
    assert.ok(ref !== undefined, `no ref for the box in:\n${tree}`);
    const result = await harness.call(session, "screenshot", { tabId: shotTab, ref });
    assert.equal(result.isError, false, result.text);
    const png = onlyImage(result);
    assert.deepEqual([png.width, png.height], [SHOT_BOX.width, SHOT_BOX.height]);
    const right = png.width - 1;
    const bottom = png.height - 1;
    for (const [x, y] of [
      [0, 0],
      [right, 0],
      [0, bottom],
      [right, bottom],
      [Math.floor(png.width / 2), Math.floor(png.height / 2)],
    ] as const) {
      assertColour(png, x, y, SHOT_COLOURS.box);
    }
    const afterShot = JSON.parse(String(await firefox.evaluate(context, SCROLL_AND_BOX)));
    assert.ok(afterShot.scrollY > 0, JSON.stringify(afterShot));
    assert.ok(
      afterShot.box.left >= 0 &&
        afterShot.box.top >= 0 &&
        afterShot.box.right <= afterShot.width &&
        afterShot.box.bottom <= afterShot.height,
      JSON.stringify(afterShot),
    );
  });

  test("saveTo writes a new PNG in the session's working folder, and nowhere else", async () => {
    const saving = await harness.connect({}, { cwd: work });
    await harness.waitUntilReady(saving);
    const tab = await open(saving, "/shot", TITLES.shot);
    const result = await harness.call(saving, "screenshot", { tabId: tab, saveTo: "shot.png" });
    assert.equal(result.isError, false, result.text);
    const file = join(await realpath(work), "shot.png");
    assert.equal(result.texts.at(-1), `Saved the screenshot to ${file}.`);
    assert.equal(result.images.length, 1);
    const saved = await readFile(file);
    assert.deepEqual([...saved.subarray(0, 8)], PNG_SIGNATURE);
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    const again = await harness.refused(saving, "screenshot", { tabId: tab, saveTo: "shot.png" });
    assert.ok(again.includes("already exists"), again);
    assert.deepEqual(await readFile(file), saved);

    const up = await harness.refused(saving, "screenshot", { tabId: tab, saveTo: "../shot.png" });
    assert.ok(up.includes("outside the folder Foxhand was started in"), up);
    await assert.rejects(lstat(join(outer, "shot.png")), { code: "ENOENT" });
    const dot = await harness.refused(saving, "screenshot", { tabId: tab, saveTo: ".shot.png" });
    assert.ok(dot.includes("starting with a dot"), dot);
    await assert.rejects(lstat(join(work, ".shot.png")), { code: "ENOENT" });
  });

  test("a tab on a site the session has not approved is refused with no image", async () => {
    const tab = tabOf(
      await harness.ok(session, "tab_open", { url: fixtures.url("/read-redirect") }),
    );
    const other = `http://localhost:${fixtures.port}`;
    const result = await harness.call(session, "screenshot", { tabId: tab.id });
    assert.equal(result.isError, true, result.text);
    assert.ok(
      result.text.includes(`Foxhand is not allowed on ${other} in this session`),
      result.text,
    );
    assert.deepEqual(result.images, []);
  });

  async function open(on: Session, path: string, title: string): Promise<number> {
    const tab = tabOf(await harness.ok(on, "tab_open", { url: fixtures.url(path) }));
    assert.equal(tab.title, title);
    return tab.id;
  }

  async function contextOf(url: string): Promise<string> {
    const found = (await firefox.contexts()).find((context) => context.url === url);
    assert.ok(found !== undefined, `no tab shows ${url}`);
    return found.context;
  }
});

function onlyImage(result: ToolResult): Png {
  assert.equal(result.images.length, 1, JSON.stringify(result.texts));
  const [image] = result.images;
  assert.equal(image?.mimeType, "image/png");
  return decodePng(image?.data ?? "");
}

function assertColour(png: Png, x: number, y: number, expected: readonly number[]): void {
  const at = (y * png.width + x) * png.channels;
  const actual = [...png.pixels.subarray(at, at + 3)];
  assert.ok(
    actual.every((channel, index) => Math.abs(channel - (expected[index] ?? -999)) <= TOLERANCE),
    `pixel (${x}, ${y}) is rgb(${actual.join(", ")}), not rgb(${expected.join(", ")})`,
  );
}

/** Decodes an 8-bit RGB or RGBA, non-interlaced PNG, the kind Firefox's captureTab writes. */
function decodePng(base64: string): Png {
  const bytes = Buffer.from(base64, "base64");
  assert.deepEqual([...bytes.subarray(0, 8)], PNG_SIGNATURE, "not a PNG");
  let header: Buffer | undefined;
  const data: Buffer[] = [];
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = body;
    if (type === "IDAT") data.push(body);
    if (type === "IEND") break;
    // Length, type, body and CRC.
    offset += 12 + length;
  }
  assert.ok(header !== undefined, "the PNG has no IHDR chunk");
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [bitDepth, colourType, , , interlace] = header.subarray(8, 13);
  assert.equal(bitDepth, 8, "the PNG is not 8 bits per channel");
  assert.ok(colourType === 2 || colourType === 6, `the PNG has colour type ${colourType}`);
  assert.equal(interlace, 0, "the PNG is interlaced");
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(data));
  assert.equal(raw.length, (stride + 1) * height, "the PNG's image data has the wrong size");
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= channels ? (pixels[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = x >= channels && y > 0 ? (pixels[(y - 1) * stride + x - channels] ?? 0) : 0;
      pixels[y * stride + x] = (value + predictor(filter, left, up, upLeft)) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function predictor(filter: number | undefined, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return Math.floor((left + up) / 2);
    case 4:
      return paeth(left, up, upLeft);
    default:
      assert.fail(`the PNG has row filter ${String(filter)}`);
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}
