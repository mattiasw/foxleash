import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const TITLES = {
  a: "Fixture page A",
  b: "Fixture page B",
  slow: "Fixture slow page",
  probe: "Fixture probe page",
  readForm: "Fixture read form",
  readLandmarks: "Fixture read landmarks",
  readHidden: "Fixture read hidden",
  readShadow: "Fixture read shadow",
  readFrame: "Fixture read frame",
  readLarge: "Fixture read large",
  readRefs: "Fixture read refs",
} as const;

/** Field values the read form holds that read_page must never return. */
export const READ_SECRETS = {
  passwordAttribute: "pw-attribute-K3v9Lq",
  passwordScript: "pw-script-T8q1Wd",
  oneTimeCode: "otc-value-492817",
  oneTimeCodeArea: "otc-area-55ZpXr",
  toggled: "pw-toggled-Hm7wYc",
  bare: "pw-bare-Nf2GsP",
  hidden: "pw-hidden-Lc8RtJ",
  shadow: "pw-shadow-Qe3VbN",
} as const;

/** Text the read pages hold that read_page must leave out. */
export const READ_HIDDEN = {
  labelPart: "hidden-label-part-Ve4",
  display: "hidden-display-Qa1",
  attribute: "hidden-attribute-Rb2",
  aria: "hidden-aria-Sc3",
  inert: "hidden-inert-Td4",
  visibility: "hidden-visibility-Ue5",
  answer: "hidden-answer-Wf6",
  contentVisibility: "hidden-content-visibility-Vj0",
  fallback: "hidden-fallback-Xg7",
  frame: "frame-inner-text-Yh8",
} as const;

export const READ_VISIBLE_MARKER = "visible-marker-Zi9";
/** The number of items on the large page, enough for a tree over 50,000 characters. */
export const READ_LARGE_ITEMS = 2000;

/** Page text the probe page holds, which no probe report may contain. */
export const PROBE_SECRET = "fixture-secret-7Q2xZ9kL";

// Must stay above the extension's LOAD_GRACE_MS (1000 ms, apps/extension/src/wait-for-load.ts):
// the held response is what makes the navigate test fail when the load wait returns early.
const SLOW_HOLD_MS = 1500;

const COUNTER_PREFIX = "Counter ";

export interface FixtureServer {
  /** The server's site, `http://127.0.0.1:<port>`, as the extension names it. */
  site: string;
  /** The server's port. */
  port: number;
  url(path: string): string;
  /** How many requests reached this path, 404s included. */
  hits(path: string): number;
  close(): Promise<void>;
}

/** Serves the fixture pages on 127.0.0.1 at a free port. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const timers = new Set<NodeJS.Timeout>();
  let counter = 0;
  const hits = new Map<string, number>();

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/a") {
      sendPage(response, TITLES.a);
    } else if (path === "/b") {
      sendPage(response, TITLES.b);
    } else if (path === "/slow") {
      const timer = setTimeout(() => {
        timers.delete(timer);
        sendPage(response, TITLES.slow);
      }, SLOW_HOLD_MS);
      timers.add(timer);
    } else if (path === "/probe") {
      sendHtml(response, PROBE_PAGE);
    } else if (path === "/read-form") {
      sendHtml(response, READ_FORM_PAGE);
    } else if (path === "/read-landmarks") {
      sendHtml(response, READ_LANDMARKS_PAGE);
    } else if (path === "/read-hidden") {
      sendHtml(response, READ_HIDDEN_PAGE);
    } else if (path === "/read-shadow") {
      sendHtml(response, READ_SHADOW_PAGE);
    } else if (path === "/read-frame") {
      sendHtml(response, READ_FRAME_PAGE);
    } else if (path === "/read-frame-inner") {
      sendHtml(response, READ_FRAME_INNER_PAGE);
    } else if (path === "/read-large") {
      sendHtml(response, readLargePage());
    } else if (path === "/read-refs") {
      sendHtml(response, READ_REFS_PAGE);
    } else if (path === "/read-redirect") {
      // To the same server under another site, which the tests never approve.
      response.writeHead(302, { Location: `http://localhost:${request.socket.localPort}/a` });
      response.end();
    } else if (path === "/counter") {
      counter += 1;
      sendPage(response, counterTitle(counter));
    } else {
      // Firefox asks for /favicon.ico; it must not reach the counter.
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
    }
  });

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fixture server has no TCP address");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    site: origin,
    port: address.port,
    url: (path) => `${origin}${path}`,
    hits: (path) => hits.get(path) ?? 0,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

function sendPage(response: ServerResponse, title: string): void {
  sendHtml(
    response,
    `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body><h1>${title}</h1></body></html>\n`,
  );
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    // So reload and back fetch the page again.
    "Cache-Control": "no-store",
  });
  response.end(html);
}

// A skip link, a form whose action the server counts and whose input submits it on every input
// event, an editable area and a disclosure toggle whose page-world listener flips aria-expanded
// and counts the flips in window.toggles. Ahead of them, elements the probe must skip: a
// one-time code field (window.codeInputs counts its input events), a toggle that is a submit
// button, and one inside a link. window.escaped counts the events that reach the document from
// elements outside the page's own content, which are the probe's.
const PROBE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.probe}</title></head>
<body>
<div id="content">
<a href="#main">Skip to content</a>
<p>${PROBE_SECRET}</p>
<input id="code" type="text" autocomplete="one-time-code">
<form action="/probe-submit" method="get">
<input id="site-input" type="text" name="q" value="${PROBE_SECRET}" oninput="this.form.requestSubmit()">
<button type="submit">Search</button>
<button aria-expanded="false">Options</button>
</form>
<div id="editable" contenteditable="true">${PROBE_SECRET}</div>
<a href="/probe-nav"><span role="button" aria-expanded="false">Menu</span></a>
<button id="toggle" type="button" aria-expanded="false" aria-label="${PROBE_SECRET}">More</button>
<main id="main"><h1>${TITLES.probe}</h1></main>
</div>
<script>
window.toggles = 0;
window.codeInputs = 0;
window.escaped = 0;
document.getElementById("toggle").addEventListener("click", (event) => {
  const toggle = event.currentTarget;
  toggle.setAttribute("aria-expanded", String(toggle.getAttribute("aria-expanded") !== "true"));
  window.toggles += 1;
});
document.getElementById("code").addEventListener("input", () => {
  window.codeInputs += 1;
});
const content = document.getElementById("content");
for (const type of ["click", "pointerdown", "mousedown", "pointerup", "mouseup", "keydown",
  "keypress", "keyup", "beforeinput", "input", "change", "focusin"]) {
  document.addEventListener(type, (event) => {
    const target = event.target;
    if (target instanceof Element && target !== document.body && !content.contains(target)) {
      window.escaped += 1;
    }
  });
}
</script>
</body></html>
`;

// A sign-in form with every kind of field read_page names, credential fields with values (one
// set by the page's script), password fields the tests later turn into text and into a submit
// button (one of them hidden until then), and enough content below to scroll the page, which
// the script does.
const READ_FORM_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.readForm}</title></head>
<body>
<main>
<h2>Sign in</h2>
<form aria-label="Sign in" action="/a">
<label for="email">Email</label>
<input id="email" type="email" value="me@example.com" required>
<label>Password <input id="password" type="password" value="${READ_SECRETS.passwordAttribute}"></label>
<input id="password-script" type="password" aria-label="Second password">
<input id="password-empty" type="password" aria-label="Empty password">
<span id="code-label">Code</span>
<input id="code" type="text" autocomplete="one-time-code" value="${READ_SECRETS.oneTimeCode}" aria-labelledby="code-label">
<input id="search" type="search" placeholder="Search the site">
<input id="remember" type="checkbox" checked><label for="remember">Remember me</label>
<select id="plan" aria-label="Plan"><option>Free</option><option selected>Pro</option></select>
<textarea id="notes" aria-label="Notes" disabled></textarea>
<textarea id="code-area" autocomplete="one-time-code" aria-label="Backup code">${READ_SECRETS.oneTimeCodeArea}</textarea>
<button id="code-button" type="button" aria-labelledby="code-area">Use code</button>
<input id="account" type="text" aria-label="Account" value="acct-1" readonly>
<input id="day" type="date" aria-label="Day">
<label for="nickname">Nickname<span hidden> ${READ_HIDDEN.labelPart}</span></label>
<input id="nickname" type="text">
<input id="toggle" type="password" aria-label="Toggled password" value="${READ_SECRETS.toggled}">
<input id="bare" type="password" value="${READ_SECRETS.bare}">
<div id="later" hidden><input id="hidden-password" type="password" aria-label="Hidden password" value="${READ_SECRETS.hidden}"></div>
<button type="submit">Sign in</button>
</form>
<div style="height: 3000px">Below the form</div>
</main>
<script>
document.getElementById("password-script").value = "${READ_SECRETS.passwordScript}";
window.scrollTo(0, 120);
</script>
</body></html>
`;

// Landmarks inside each other, an article whose header is no banner, a named section (a
// region) and an unnamed one (none).
const READ_LANDMARKS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.readLandmarks}</title></head>
<body>
<header><nav aria-label="Main"><a href="/a">Home</a> <a href="/b">Docs</a></nav></header>
<main>
<h1>Landmarks</h1>
<article><header><h3>Article title</h3></header><p>Article text</p></article>
<section aria-label="News"><h2>News</h2><p>News text</p></section>
<section><p>Unnamed section text</p></section>
</main>
<aside><p>Aside text</p></aside>
<footer><p>Footer text</p></footer>
</body></html>
`;

const READ_HIDDEN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.readHidden}</title></head>
<body>
<p style="display: none">${READ_HIDDEN.display}</p>
<p hidden>${READ_HIDDEN.attribute}</p>
<p aria-hidden="true">${READ_HIDDEN.aria}</p>
<p inert>${READ_HIDDEN.inert}</p>
<div style="visibility: hidden">${READ_HIDDEN.visibility}<button style="visibility: visible">Visible child</button></div>
<details><summary>Question</summary>${READ_HIDDEN.answer}</details>
<div style="content-visibility: hidden">${READ_HIDDEN.contentVisibility}</div>
<video controls>${READ_HIDDEN.fallback}</video>
<p>${READ_VISIBLE_MARKER}</p>
</body></html>
`;

// Two custom elements, one with an open and one with a closed shadow root, each holding a
// button, a group with a button in it, and a slot for the element's own text. The closed
// root's first button has the focus, and the closed root also holds a filled password field.
const READ_SHADOW_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.readShadow}</title></head>
<body>
<open-widget>Slotted open text</open-widget>
<closed-widget>Slotted closed text</closed-widget>
<script>
for (const [name, mode, label] of [
  ["open-widget", "open", "Open button"],
  ["closed-widget", "closed", "Closed button"],
]) {
  customElements.define(name, class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode });
      const button = document.createElement("button");
      button.textContent = label;
      const group = document.createElement("div");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", label + " panel");
      const inner = document.createElement("button");
      inner.textContent = label + " inside";
      group.append(inner);
      root.append(button, group, document.createElement("slot"));
      if (mode === "closed") {
        window.closedButton = button;
        const field = document.createElement("input");
        field.type = "password";
        field.setAttribute("aria-label", "Shadow password");
        field.value = "${READ_SECRETS.shadow}";
        root.append(field);
        window.shadowPassword = field;
      }
    }
  });
}
window.closedButton.focus();
</script>
</body></html>
`;

const READ_FRAME_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.readFrame}</title></head>
<body>
<p>Before the frame</p>
<iframe title="Chat" src="/read-frame-inner"></iframe>
</body></html>
`;

const READ_FRAME_INNER_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Frame</title></head>
<body><p>${READ_HIDDEN.frame}</p><a href="/a">Frame link</a></body></html>
`;

const READ_REFS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.readRefs}</title></head>
<body>
<button id="keep" type="button">Keep</button>
<button id="remove" type="button">Remove me</button>
<a role="link" tabindex="0">No address</a>
<button type="button"><img alt="Close"></button>
<a href="/a"><svg aria-label="Home" width="10" height="10"></svg></a>
</body></html>
`;

/** A list long enough that its tree passes 50,000 characters, with a link every 100 items. */
function readLargePage(): string {
  const items: string[] = [];
  for (let index = 1; index <= READ_LARGE_ITEMS; index += 1) {
    const number = String(index).padStart(4, "0");
    items.push(
      index % 100 === 0
        ? `<li><a href="/a">Link ${number}</a></li>`
        : `<li>Item ${number} lorem ipsum dolor sit amet</li>`,
    );
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.readLarge}</title></head>
<body><ul>
${items.join("\n")}
</ul></body></html>
`;
}

export function counterTitle(count: number): string {
  return `${COUNTER_PREFIX}${count}`;
}

export function parseCount(title: string): number {
  const match = /^Counter ([0-9]+)$/.exec(title);
  if (match === null) throw new Error(`not a counter page title: ${JSON.stringify(title)}`);
  return Number(match[1]);
}
