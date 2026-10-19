import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const TITLES = {
  a: "Fixture page A",
  b: "Fixture page B",
  slow: "Fixture slow page",
  probe: "Fixture probe page",
} as const;

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

export function counterTitle(count: number): string {
  return `${COUNTER_PREFIX}${count}`;
}

export function parseCount(title: string): number {
  const match = /^Counter ([0-9]+)$/.exec(title);
  if (match === null) throw new Error(`not a counter page title: ${JSON.stringify(title)}`);
  return Number(match[1]);
}
