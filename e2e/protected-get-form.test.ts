import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Firefox, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import {
  AUTOFILL_LOGIN,
  type FixtureServer,
  PROTECTED_FORM_SECRETS,
  startFixtureServer,
  TITLES,
} from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  type Session,
  tabOf,
  tabsOf,
  untrustedContent,
} from "./harness.ts";

const REF = "([a-z]{1,7}[1-9][0-9]*)";
// Long enough for a navigation Firefox itself would queue to have started.
const SETTLE_MS = 300;
const AUTOFILLED = 'document.getElementById("login-name").matches(":autofill")';
const STATUS = 'document.getElementById("status").textContent';
const HANDLED = "Handled by the page";
const SENT = "/protected-sent";
const SAVED = [AUTOFILL_LOGIN.username, AUTOFILL_LOGIN.password];

interface Page {
  url: string;
  tabId: number;
  context: string;
  tree: string;
}

// One Firefox for the file: the tests run in order.
describe("a click or Enter on a GET form with a protected field, in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let login: Page | undefined;
  let opened = 0;

  before(
    async () => {
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
        await fixtures?.close();
      }
    },
    { timeout: 60_000 },
  );

  test("Enter in a form without a method that Firefox filled from a saved login is refused", async () => {
    login = await filled("/protected-get");
    const page = login;
    const name = protectedRef(page.tree, "Login name");
    const password = protectedRef(page.tree, "Password");
    await unchanged(page, async () => {
      const text = await harness.refused(session, "press_key", {
        tabId: page.tabId,
        key: "Enter",
        ref: password,
      });
      assertRefusal(text, name, SAVED);
    });
    assert.equal(await firefox.evaluate(page.context, AUTOFILLED), true);
  });

  test("a click on that form's submit button is refused the same way", async () => {
    login ??= await filled("/protected-get");
    const page = login;
    const name = protectedRef(page.tree, "Login name");
    await unchanged(page, async () => {
      const text = await harness.refused(session, "click", {
        tabId: page.tabId,
        ref: refOf(page.tree, 'button "Sign in"'),
      });
      assertRefusal(text, name, SAVED);
    });
    assert.equal(await firefox.evaluate(page.context, AUTOFILLED), true);
  });

  test("a click on a submit button whose formmethod sends a POST form with GET is refused", async () => {
    const page = await filled("/protected-formmethod");
    const name = protectedRef(page.tree, "Login name");
    await unchanged(page, async () => {
      const text = await harness.refused(session, "click", {
        tabId: page.tabId,
        ref: refOf(page.tree, 'button "Sign in"'),
      });
      assertRefusal(text, name, SAVED);
    });
  });

  test("Enter in a GET form whose script handles the submission on window works", async () => {
    const page = await filled("/protected-get-handled");
    const password = protectedRef(page.tree, "Password");
    await unchanged(page, async () => {
      await harness.ok(session, "press_key", { tabId: page.tabId, key: "Enter", ref: password });
    });
    assert.equal(await firefox.evaluate(page.context, STATUS), HANDLED);
  });

  test("Enter in a POST form sends it, with nothing in the address", async () => {
    const page = await filled("/protected-post");
    const password = protectedRef(page.tree, "Password");
    const before = fixtures.hits(SENT);
    await harness.ok(session, "press_key", { tabId: page.tabId, key: "Enter", ref: password });
    const url = await reaches(page.tabId, (listed) => listed === fixtures.url(SENT));
    assert.ok(!url.includes("?"), url);
    for (const secret of SAVED) assert.ok(!url.includes(secret), url);
    assert.equal(fixtures.hits(SENT), before + 1, `requests for ${SENT}`);
  });

  test("a click on the submit button of a GET form in a closed shadow root is refused", async () => {
    const page = await open("/protected-shadow");
    const password = protectedRef(page.tree, "Password");
    // Twice in the same document: a listener the first act left on the shadow root would cancel
    // the second submission before the second act's own listener could refuse it.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await unchanged(page, async () => {
        const text = await harness.refused(session, "click", {
          tabId: page.tabId,
          ref: refOf(page.tree, 'button "Sign in"'),
        });
        assertRefusal(text, password, [PROTECTED_FORM_SECRETS.shadow]);
      });
    }
  });

  test("Enter in a GET form slotted into a shadow root, which the page handles on document, works", async () => {
    const page = await open("/protected-slotted");
    const password = protectedRef(page.tree, "Password");
    await unchanged(page, async () => {
      await harness.ok(session, "press_key", { tabId: page.tabId, key: "Enter", ref: password });
    });
    assert.equal(await firefox.evaluate(page.context, STATUS), HANDLED);
  });

  test("Enter in a GET form with only a password field and no button is refused", async () => {
    const page = await open("/protected-alone");
    const password = protectedRef(page.tree, "Password");
    await unchanged(page, async () => {
      const text = await harness.refused(session, "press_key", {
        tabId: page.tabId,
        key: "Enter",
        ref: password,
      });
      assertRefusal(text, password, [PROTECTED_FORM_SECRETS.alone]);
    });
  });

  test("Enter in a GET form whose protected fields are unnamed, disabled or empty sends it", async () => {
    const page = await open("/protected-unsent");
    const before = fixtures.hits(SENT);
    await harness.ok(session, "press_key", {
      tabId: page.tabId,
      key: "Enter",
      ref: refOf(page.tree, 'textbox "Query"'),
    });
    const url = await reaches(page.tabId, (listed) => listed.startsWith(fixtures.url(`${SENT}?`)));
    assert.ok(url.includes("q=plain-query"), url);
    assert.ok(url.includes("empty="), url);
    for (const secret of [
      PROTECTED_FORM_SECRETS.unnamed,
      PROTECTED_FORM_SECRETS.disabled,
      PROTECTED_FORM_SECRETS.fenced,
    ]) {
      assert.ok(!url.includes(secret), url);
    }
    assert.equal(fixtures.hits(SENT), before + 1, `requests for ${SENT}`);
  });

  test("a click that would send a GET form with a form-associated password element is refused", async () => {
    const page = await open("/protected-face");
    const password = protectedRef(page.tree, "Password");
    await unchanged(page, async () => {
      const text = await harness.refused(session, "click", {
        tabId: page.tabId,
        ref: refOf(page.tree, 'button "Sign in"'),
      });
      assertRefusal(text, password, [PROTECTED_FORM_SECRETS.face]);
    });
  });

  test("a click that would send a GET form with a form-associated element around a password is refused", async () => {
    const page = await open("/protected-wrapped");
    const password = protectedRef(page.tree, "Password");
    await unchanged(page, async () => {
      const text = await harness.refused(session, "click", {
        tabId: page.tabId,
        ref: refOf(page.tree, 'button "Sign in"'),
      });
      assertRefusal(text, password, [PROTECTED_FORM_SECRETS.wrapped]);
    });
  });

  async function open(path: string): Promise<Page> {
    opened += 1;
    const url = fixtures.url(`${path}?tab=${opened}`);
    const tab = tabOf(await harness.ok(session, "tab_open", { url }));
    assert.equal(tab.title, TITLES.protectedForm, `unexpected tab ${JSON.stringify(tab)}`);
    const found = (await firefox.contexts()).find((context) => context.url === url);
    assert.ok(found !== undefined, `no tab shows ${url}`);
    return { url, tabId: tab.id, context: found.context, tree: await readTree(tab.id) };
  }

  /** Opens `path` with the saved login, and reads it once Firefox filled the login in. */
  async function filled(path: string): Promise<Page> {
    let page: Page;
    await firefox.saveLogin(fixtures.site, AUTOFILL_LOGIN.username, AUTOFILL_LOGIN.password);
    try {
      // tab_open makes the tab active: login autofill waits for a visible document.
      page = await open(path);
      const context = page.context;
      await pollUntil(
        async () => ((await firefox.evaluate(context, AUTOFILLED)) === true ? true : undefined),
        PAGE_TIMEOUT_MS,
        `Firefox to fill the saved login into ${path}`,
      );
    } finally {
      await firefox.removeLogins();
    }
    return { ...page, tree: await readTree(page.tabId) };
  }

  async function readTree(tabId: number): Promise<string> {
    const read = await harness.call(session, "read_page", { tabId });
    assert.equal(read.isError, false, read.text);
    return untrustedContent(read.text) ?? "";
  }

  /** Runs `step`, then asserts the tab still shows the page and nothing reached the destination. */
  async function unchanged(page: Page, step: () => Promise<void>): Promise<void> {
    const before = fixtures.hits(SENT);
    await step();
    await sleep(SETTLE_MS);
    assert.equal(await listedUrl(page.tabId), page.url);
    assert.equal(fixtures.hits(SENT), before, `requests for ${SENT}`);
  }

  /** The address `tabs_list` gives for the tab, once `accept` takes it. */
  function reaches(tabId: number, accept: (url: string) => boolean): Promise<string> {
    return pollUntil(
      async () => {
        const url = await listedUrl(tabId);
        return url !== undefined && accept(url) ? url : undefined;
      },
      PAGE_TIMEOUT_MS,
      `tab ${tabId} to reach ${SENT}`,
    );
  }

  async function listedUrl(tabId: number): Promise<string | undefined> {
    return tabsOf(await harness.ok(session, "tabs_list")).find(({ id }) => id === tabId)?.url;
  }
});

/** The ref of a protected field that read_page shows as filled. */
function protectedRef(tree: string, label: string): string {
  return refOf(tree, `textbox "${label}"`, " protected filled");
}

function refOf(tree: string, line: string, rest = ""): string {
  const ref = new RegExp(`${line} \\[${REF}\\]${rest}`).exec(tree)?.[1];
  assert.ok(ref !== undefined, `no ref for ${line}${rest} in:\n${tree}`);
  return ref;
}

function assertRefusal(text: string, ref: string, secrets: readonly string[]): void {
  assert.ok(text.includes(`protected field ${ref} `), text);
  assert.ok(text.includes("sent with GET"), text);
  for (const secret of secrets) assert.ok(!text.includes(secret), `the refusal holds ${secret}`);
}
