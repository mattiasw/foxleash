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
  readRefHidden: "Fixture read ref hidden",
  textMain: "Fixture text main",
  textRoleMain: "Fixture text role main",
  textArticle: "Fixture text article",
  textBlock: "Fixture text block",
  textHiddenBody: "Fixture text hidden body",
  textSlotted: "Fixture text slotted",
  textDetails: "Fixture text details",
  shot: "Fixture shot",
  shotFields: "Fixture shot fields",
  shotPdfFrame: "Fixture shot PDF frame",
  upload: "Fixture upload",
  act: "Fixture act",
  actLinks: "Fixture act links",
  actScroll: "Fixture act scroll",
  actModal: "Fixture act modal",
  actBodyScroll: "Fixture act body scroll",
  actDrag: "Fixture act drag",
  actBase: "Fixture act base",
  actEmbed: "Fixture act embed",
  console: "Fixture console",
  consoleCsp: "Fixture console CSP",
  network: "Fixture network",
  networkDone: "Fixture network done",
  networkHop: "Fixture network hop",
  waitLate: "Fixture wait late",
  waitNavigate: "Fixture wait navigate",
} as const;

/** The text the wait-late page adds, in an element with the id late, after WAIT_LATE_MS. */
export const WAIT_LATE_TEXT = "The late text has arrived";
/** How long the wait pages wait after loading before they add their text or navigate. */
export const WAIT_LATE_MS = 2000;

/** What the console pages log, each in one message. */
export const CONSOLE_TOKENS = {
  debug: "console-debug-Wq4",
  log: "console-log-Er5",
  info: "console-info-Ty6",
  warn: "console-warn-Ui7",
  error: "console-error-Op8",
  uncaught: "console-uncaught-As9",
  rejection: "console-rejection-Df1",
  csp: "console-csp-Gh2",
} as const;

/** The only nonce the console CSP page's policy lets scripts run with. */
export const CONSOLE_CSP_NONCE = "fixtureNonce7Jk";

/** The credentials the network page sends and gets, which read_network must never show. */
export const NETWORK_SECRETS = {
  bearer: "network-bearer-Vb3Nq8",
  cookie: "network-cookie-Hs5Tz2",
} as const;

/** The name of the cookie /api/fetch sets. */
export const NETWORK_COOKIE = "fixture_session";

/** The middle of the Log button on both console pages, in CSS pixels. */
export const CONSOLE_LOG_POINT = { x: 70, y: 30 } as const;

/** The data the act-drag page's draggable source puts in its dataTransfer. */
export const ACT_DRAG_DATA = "drag-payload-Kx7";

/** The CSS size of the shot page's box, which a screenshot by its ref must have. */
export const SHOT_BOX = { width: 120, height: 80 } as const;
/** The shot page's background and its box's colour, as RGB. */
export const SHOT_COLOURS = {
  page: [255, 228, 181],
  box: [30, 144, 255],
} as const;

/**
 * The text colours of the shot-fields page, as RGB: every protected field's, which nothing else
 * there uses, a plain field's in each context, and the selected text of the top plain field.
 */
export const SHOT_FIELD_COLOURS = {
  protected: [201, 17, 149],
  top: [0, 128, 64],
  shadow: [160, 96, 0],
  frame: [0, 64, 192],
  data: [112, 48, 160],
  selection: [255, 120, 0],
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
  namespacedOpen: "hidden-namespaced-open-Ha2",
  foreignSummary: "hidden-foreign-summary-Ib3",
  detailsVisibility: "hidden-details-visibility-Jc4",
  detailsContentVisibilityChild: "hidden-details-cv-child-Le6",
  detailsDisplay: "hidden-details-display-Mf7",
  detailsDisplayChild: "hidden-details-display-child-Ng8",
  detailsOwnBox: "hidden-details-own-box-Sm4",
  detailsInName: "hidden-details-in-name-Qj1",
  detailsInNameChild: "hidden-details-in-name-child-Tn5",
  detailsOwnName: "hidden-details-own-name-Rk2",
  detailsContentVisibility: "hidden-details-content-visibility-Kd5",
  foreignDetails: "hidden-foreign-details-Wq8",
} as const;

/** Text the get_page_text pages hold in each region, to find where each region went. */
export const TEXT_TOKENS = {
  nav: "text-nav-Ka1",
  mainHeading: "text-main-heading-Lb2",
  mainFirst: "text-main-first-Mc3",
  mainSecond: "text-main-second-Nd4",
  mainHidden: "text-main-hidden-Oe5",
  mainValue: "text-main-value-Pf6",
  aside: "text-aside-Qg7",
  asideValue: "text-aside-value-Rh8",
  password: "text-password-Si9",
  asideArea: "text-aside-area-Tj0",
  footer: "text-footer-Uk1",
  bodyText: "text-body-text-Vl2",
  contents: "text-contents-Wm3",
  bodyHidden: "text-body-hidden-Xn4",
  bodyInvisible: "text-body-invisible-Yo5",
  bodyArea: "text-body-area-Zp6",
  contentsArea: "text-contents-area-Aq7",
  contentsAnswer: "text-contents-answer-Br8",
  contentsParagraph: "text-contents-paragraph-Ci9",
  contentsNested: "text-contents-nested-Dj0",
  unslotted: "text-unslotted-Cs9",
  script: "text-script-Dt0",
  style: "text-style-Eu1",
  noscript: "text-noscript-Fv2",
  hiddenMain: "text-hidden-main-Gw3",
  roleMain: "text-role-main-Hx4",
  roleHeader: "text-role-header-Iy5",
  shortArticle: "text-short-article-Jz6",
  longArticle: "text-long-article-Ka7",
  sidebar: "text-sidebar-Lb8",
  block: "text-block-Mc9",
  blockArea: "text-block-area-Nd0",
  hiddenBody: "text-hidden-body-Oe1",
  hiddenContents: "text-hidden-contents-Pf2",
  slottedMain: "text-slotted-main-Qg3",
  slottedHidden: "text-slotted-hidden-Rh4",
  slottedSkipped: "text-slotted-skipped-Si5",
  canvas: "text-canvas-Tj6",
  detailsSummary: "text-details-summary-Ua1",
  detailsMain: "text-details-main-Vb2",
  summaryMain: "text-summary-main-Wc3",
  summaryAnswer: "text-summary-answer-Xd4",
  summaryParagraph: "text-summary-paragraph-Ye5",
  namespacedAnswer: "text-namespaced-answer-Zf6",
  foreignSummary: "text-foreign-summary-Ag7",
  styledAnswer: "text-styled-answer-Bh8",
  openParagraph: "text-open-paragraph-Ek2",
} as const;

export const READ_VISIBLE_MARKER = "visible-marker-Zi9";
/** Text an open disclosure on the read-hidden page shows, which both read tools must keep. */
export const READ_OPEN_DETAILS = {
  answer: "visible-open-answer-Oh9",
  paragraph: "visible-open-paragraph-Pi0",
  contentsChild: "visible-open-contents-child-Sl3",
  inName: "visible-open-in-name-Vp7",
  revealed: "visible-revealed-Uo6",
} as const;
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
    } else if (path === "/wait-late") {
      sendHtml(response, WAIT_LATE_PAGE);
    } else if (path === "/wait-navigate") {
      sendHtml(response, WAIT_NAVIGATE_PAGE);
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
    } else if (path === "/read-ref-hidden") {
      sendHtml(response, READ_REF_HIDDEN_PAGE);
    } else if (path === "/text-main") {
      sendHtml(response, TEXT_MAIN_PAGE);
    } else if (path === "/text-role-main") {
      sendHtml(response, TEXT_ROLE_MAIN_PAGE);
    } else if (path === "/text-article") {
      sendHtml(response, TEXT_ARTICLE_PAGE);
    } else if (path === "/text-block") {
      sendHtml(response, TEXT_BLOCK_PAGE);
    } else if (path === "/text-hidden-body") {
      sendHtml(response, TEXT_HIDDEN_BODY_PAGE);
    } else if (path === "/text-slotted") {
      sendHtml(response, TEXT_SLOTTED_PAGE);
    } else if (path === "/text-details") {
      sendHtml(response, TEXT_DETAILS_PAGE);
    } else if (path === "/shot") {
      sendHtml(response, SHOT_PAGE);
    } else if (path === "/shot-fields") {
      // The frame from another site is the same server under localhost.
      sendHtml(response, shotFieldsPage(request.socket.localPort ?? 0));
    } else if (path === "/shot-fields-frame") {
      sendHtml(response, shotFieldsFrame(SHOT_FIELD_COLOURS.frame));
    } else if (path === "/shot-pdf-frame") {
      sendHtml(response, SHOT_PDF_FRAME_PAGE);
    } else if (path === "/shot.pdf") {
      response.writeHead(200, { "Content-Type": "application/pdf", "Cache-Control": "no-store" });
      response.end(minimalPdf());
    } else if (path === "/upload") {
      sendHtml(response, UPLOAD_PAGE);
    } else if (path === "/act") {
      sendHtml(response, ACT_PAGE);
    } else if (path === "/act-links") {
      // The other site is the same server under localhost.
      sendHtml(response, actLinksPage(request.socket.localPort ?? 0));
    } else if (path === "/act-scroll") {
      sendHtml(response, ACT_SCROLL_PAGE);
    } else if (path === "/act-modal") {
      sendHtml(response, ACT_MODAL_PAGE);
    } else if (path === "/act-body-scroll") {
      sendHtml(response, ACT_BODY_SCROLL_PAGE);
    } else if (path === "/act-drag") {
      sendHtml(response, ACT_DRAG_PAGE);
    } else if (path === "/act-base") {
      // Relative links resolve against the other site.
      sendHtml(response, actBasePage(request.socket.localPort ?? 0));
    } else if (path === "/act-embed") {
      sendHtml(response, ACT_EMBED_PAGE);
    } else if (path === "/act-redirect") {
      // To the act page on another site, which the tests never approve.
      response.writeHead(302, { Location: `http://localhost:${request.socket.localPort}/act` });
      response.end();
    } else if (path === "/read-redirect") {
      // To the same server under another site, which the tests never approve.
      response.writeHead(302, { Location: `http://localhost:${request.socket.localPort}/a` });
      response.end();
    } else if (path === "/console") {
      sendHtml(response, CONSOLE_PAGE);
    } else if (path === "/console-csp") {
      sendHtml(response, CONSOLE_CSP_PAGE, {
        "Content-Security-Policy": `script-src 'nonce-${CONSOLE_CSP_NONCE}'`,
      });
    } else if (path === "/network") {
      // The frame from another site is the same server under localhost.
      sendHtml(response, networkPage(request.socket.localPort ?? 0));
    } else if (path === "/network-frame") {
      sendHtml(response, NETWORK_FRAME_PAGE);
    } else if (path === "/network-hop") {
      // Leaves at once for the other site, which the tests never approve.
      sendHtml(response, networkHopPage(request.socket.localPort ?? 0));
    } else if (path === "/network-old") {
      sendHtml(response, networkOldPage(request.socket.localPort ?? 0));
    } else if (path === "/network-old-frame") {
      sendHtml(response, NETWORK_OLD_FRAME_PAGE);
    } else if (path === "/api/fetch") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": `${NETWORK_COOKIE}=${NETWORK_SECRETS.cookie}; Path=/`,
      });
      response.end('{"ok":true}');
    } else if (path === "/api/xhr" || path === "/api/frame") {
      response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end("ok");
    } else if (path === "/api/beacon-top" || path === "/api/beacon-frame") {
      response.writeHead(204, { "Cache-Control": "no-store" });
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

function sendHtml(
  response: ServerResponse,
  html: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    // So reload and back fetch the page again.
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(html);
}

// Both console pages log only when their Log button is clicked, so a test can wait until Foxhand
// records the page first.
const CONSOLE_LOG_BUTTON = `<button id="log" style="position: fixed; left: 10px; top: 10px; width: 120px; height: 40px; margin: 0">Log</button>`;

const WAIT_LATE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.waitLate}</title></head>
<body><h1>${TITLES.waitLate}</h1>
<script>
addEventListener("load", () => {
  setTimeout(() => {
    const late = document.createElement("p");
    late.id = "late";
    late.textContent = ${JSON.stringify(WAIT_LATE_TEXT)};
    document.body.append(late);
  }, ${WAIT_LATE_MS});
});
</script>
</body></html>
`;

const WAIT_NAVIGATE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.waitNavigate}</title></head>
<body><h1>${TITLES.waitNavigate}</h1>
<script>
addEventListener("load", () => {
  setTimeout(() => {
    location.href = "/a";
  }, ${WAIT_LATE_MS});
});
</script>
</body></html>
`;

// The timers keep the uncaught error and the rejection after the console calls, in that order.
const CONSOLE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.console}</title></head>
<body><h1>${TITLES.console}</h1>
${CONSOLE_LOG_BUTTON}
<script>
document.getElementById("log").addEventListener("click", () => {
  console.debug("${CONSOLE_TOKENS.debug}");
  console.log("${CONSOLE_TOKENS.log}", { n: 1 });
  console.info("${CONSOLE_TOKENS.info}");
  console.warn("${CONSOLE_TOKENS.warn}");
  console.error("${CONSOLE_TOKENS.error}");
  setTimeout(() => {
    throw new Error("${CONSOLE_TOKENS.uncaught}");
  }, 50);
  setTimeout(() => {
    Promise.reject(new Error("${CONSOLE_TOKENS.rejection}"));
  }, 100);
});
</script>
</body></html>
`;

// Its policy forbids inline script without the nonce, and eval.
const CONSOLE_CSP_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.consoleCsp}</title></head>
<body><h1>${TITLES.consoleCsp}</h1>
${CONSOLE_LOG_BUTTON}
<script nonce="${CONSOLE_CSP_NONCE}">
document.getElementById("log").addEventListener("click", () => console.log("${CONSOLE_TOKENS.csp}"));
</script>
</body></html>
`;

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

// Text hidden in each way a page can hide it: display none, the hidden attribute, aria-hidden,
// inert, visibility hidden, content-visibility hidden, video fallback, and in disclosures: a
// closed one, one whose open attribute is in a namespace, one whose first summary is not HTML,
// and open ones whose ::details-content box is hidden, or that are hidden themselves, also
// inside a heading's name and in a button's; and a hidden details in another namespace, which
// has no content box, whose ::details-content rule asks for visible text. Two open disclosures
// and one whose content box is visible inside a hidden details show their text. Each details is
// on one line, with no whitespace inside it.
const READ_HIDDEN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.readHidden}</title>
<style>
@namespace fixture url(urn:fixture);
fixture|summary { display: contents; }
#details-visibility::details-content,
#details-pressable::details-content { visibility: hidden; }
#details-content-visibility::details-content,
#details-named::details-content { content-visibility: hidden; }
#details-display::details-content { display: none; }
#details-foreign-ns { visibility: hidden; }
#details-revealed::details-content,
#details-foreign-ns::details-content { visibility: visible; }
</style></head>
<body>
<p style="display: none">${READ_HIDDEN.display}</p>
<p hidden>${READ_HIDDEN.attribute}</p>
<p aria-hidden="true">${READ_HIDDEN.aria}</p>
<p inert>${READ_HIDDEN.inert}</p>
<div style="visibility: hidden">${READ_HIDDEN.visibility}<button style="visibility: visible">Visible child</button></div>
<details><summary>Question</summary>${READ_HIDDEN.answer}</details>
<details id="details-namespaced"><summary>Namespaced</summary>${READ_HIDDEN.namespacedOpen}</details>
<details id="details-foreign"><summary>Foreign</summary></details>
<details id="details-visibility" open aria-label="Visibility box"><summary>Visibility</summary>${READ_HIDDEN.detailsVisibility}</details>
<details id="details-content-visibility" open><summary>Content visibility</summary>${READ_HIDDEN.detailsContentVisibility}<span style="display: contents">${READ_HIDDEN.detailsContentVisibilityChild}</span></details>
<details id="details-display" open><summary>Display</summary>${READ_HIDDEN.detailsDisplay}<span style="display: contents">${READ_HIDDEN.detailsDisplayChild}</span></details>
<details open style="content-visibility: hidden"><summary>Own box</summary>${READ_HIDDEN.detailsOwnBox}</details>
<h2>Named <details id="details-named" open><summary>Inner</summary>${READ_HIDDEN.detailsInName}<span style="display: contents">${READ_HIDDEN.detailsInNameChild}</span></details></h2>
<details id="details-pressable" open role="button"><summary>Pressable</summary>${READ_HIDDEN.detailsOwnName}</details>
<details open><summary>Shown</summary>${READ_OPEN_DETAILS.answer}<p>${READ_OPEN_DETAILS.paragraph}</p><span style="display: contents">${READ_OPEN_DETAILS.contentsChild}</span></details>
<h2>Plain <details open><summary>Sum</summary>${READ_OPEN_DETAILS.inName}</details></h2>
<details id="details-revealed" open style="visibility: hidden"><summary>Revealed</summary>${READ_OPEN_DETAILS.revealed}</details>
<div style="content-visibility: hidden">${READ_HIDDEN.contentVisibility}</div>
<video controls>${READ_HIDDEN.fallback}</video>
<p>${READ_VISIBLE_MARKER}</p>
<script>
document.getElementById("details-namespaced").setAttributeNS("urn:fixture", "open", "");
const foreign = document.createElementNS("urn:fixture", "summary");
foreign.textContent = "${READ_HIDDEN.foreignSummary}";
document.getElementById("details-foreign").prepend(foreign);
const foreignDetails = document.createElementNS("urn:fixture", "details");
foreignDetails.id = "details-foreign-ns";
foreignDetails.setAttribute("open", "");
foreignDetails.textContent = "${READ_HIDDEN.foreignDetails}";
document.currentScript.before(foreignDetails);
</script>
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

// Elements a test hides after the first read, to read them by ref: group roots with their own
// text, each with the holder the test moves it into (hiding ones: display none, content-visibility
// hidden, a details with a hidden content box, a closed details, display contents under display
// none, a progress, a br, a hidden host's shadow root, a host with no slot, a slot showing
// assigned nodes; showing ones: a plain div, an open details, a slot, a slot showing its
// fallback), buttons and options named from their content, and custom elements with open
// shadow roots.
const READ_REF_HIDDEN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.readRefHidden}</title>
<style>
.box-hidden::details-content { content-visibility: hidden; }
</style></head>
<body>
<div role="group" aria-label="Display root" id="root-display">Display root text</div>
<div role="group" aria-label="Content visibility root" id="root-cv">Content visibility root text</div>
<div role="group" aria-label="Box root" id="root-box">Box root text</div>
<div role="group" aria-label="Closed root" id="root-closed">Closed root text</div>
<div role="group" aria-label="Nested root" id="root-nested">Nested root text</div>
<div role="group" aria-label="Childless root" id="root-childless">Childless root text</div>
<div role="group" aria-label="Break root" id="root-br">Break root text</div>
<div role="group" aria-label="Shadow top root" id="root-shadow-top">Shadow top root text</div>
<div role="group" aria-label="Unslotted root" id="root-unslotted">Unslotted root text</div>
<div role="group" aria-label="Fallback root" id="root-fallback">Fallback root text</div>
<div role="group" aria-label="Visible root" id="root-visible">Visible root text</div>
<div role="group" aria-label="Open details root" id="root-open-details">Open details root text</div>
<div role="group" aria-label="Shown fallback root" id="root-shown-fallback">Shown fallback root text</div>
<slot-host><div role="group" aria-label="Slotted root" id="root-slotted">Slotted root text</div></slot-host>
<div id="holder-display" style="display: none"></div>
<div id="holder-cv" style="content-visibility: hidden"></div>
<details id="holder-box" class="box-hidden" open><summary>Box holder</summary></details>
<details id="holder-closed"><summary>Closed holder</summary></details>
<div style="display: none"><div id="holder-nested" style="display: contents"></div></div>
<progress id="holder-childless"></progress>
<br id="holder-br">
<top-host id="holder-shadow-top" style="display: none"></top-host>
<bare-host id="holder-unslotted"></bare-host>
<fallback-host id="holder-fallback"><span>Assigned</span></fallback-host>
<div id="holder-visible"></div>
<details id="holder-open-details" open><summary>Open holder</summary></details>
<empty-host id="holder-shown-fallback"></empty-host>
<details id="name-closed" open><summary>Closed name</summary><button id="button-closed">Go closed</button></details>
<details id="name-box" open><summary>Box name</summary><button id="button-box">Go box</button></details>
<button id="button-display">Go display</button>
<button id="button-contents">Go contents</button>
<div id="holder-button-contents" style="display: none"></div>
<button id="button-control">Go control</button>
<select id="select-hidden" aria-label="Hidden pick"><option>One</option><option id="option-hidden">Two</option></select>
<select id="select-contents" aria-label="Contents pick"><option>Five</option><option id="option-contents">Six</option></select>
<select id="select-own" aria-label="Own pick"><option>Seven</option><option id="option-own">Eight</option></select>
<select id="select-group" aria-label="Group pick"><option>Ten</option><optgroup id="optgroup-display" label="Group"><option id="option-group">Nine</option></optgroup></select>
<select id="select-control" aria-label="Control pick"><option>Three</option><option id="option-control">Four</option></select>
<script>
for (const [name, html] of [
  ["slot-host", "<div><slot></slot></div>"],
  ["top-host", ""],
  ["bare-host", "<div>Bare host</div>"],
  ["fallback-host", "<slot></slot>"],
  ["empty-host", "<slot></slot>"],
]) {
  customElements.define(name, class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML = html;
    }
  });
}
</script>
</body></html>
`;

const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

// A main element among a header, an aside with a filled form and a footer, then, directly in the
// body, text that is shown (a text node, a display: contents wrapper) and text that is not:
// hidden, the text of form fields, a closed disclosure's content and a shadow host's unslotted
// text under display: contents, script, style and noscript source, and a frame.
const TEXT_MAIN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.textMain}</title></head>
<body>
<header><nav><a href="/a">${TEXT_TOKENS.nav}</a></nav></header>
<main>
<h1>${TEXT_TOKENS.mainHeading}</h1>
<p>${TEXT_TOKENS.mainFirst} ${LOREM}</p>
<p>${TEXT_TOKENS.mainSecond} ${LOREM}</p>
<span style="display: none">${TEXT_TOKENS.mainHidden}</span>
<input type="text" aria-label="Main field" value="${TEXT_TOKENS.mainValue}">
</main>
<aside><p>${TEXT_TOKENS.aside}</p>
<form><input type="text" aria-label="Name" value="${TEXT_TOKENS.asideValue}">
<input type="password" aria-label="Password" autocomplete="current-password" value="${TEXT_TOKENS.password}">
<textarea aria-label="Message">${TEXT_TOKENS.asideArea}</textarea></form></aside>
<footer><p>${TEXT_TOKENS.footer}</p></footer>
${TEXT_TOKENS.bodyText}
<div style="display: contents"><p>${TEXT_TOKENS.contents}</p></div>
<div style="display: none">${TEXT_TOKENS.bodyHidden}</div>
<div style="visibility: hidden">${TEXT_TOKENS.bodyInvisible}</div>
<textarea aria-label="Body area">${TEXT_TOKENS.bodyArea}</textarea>
<textarea aria-label="Contents area" style="display: contents">${TEXT_TOKENS.contentsArea}</textarea>
<details style="display: contents"><summary>Question</summary>${TEXT_TOKENS.contentsAnswer}<p>${TEXT_TOKENS.contentsParagraph}</p><span style="display: contents">${TEXT_TOKENS.contentsNested}</span></details>
<div id="host" style="display: contents">${TEXT_TOKENS.unslotted}</div>
<script>
const unread = "${TEXT_TOKENS.script}";
const shadow = document.getElementById("host").attachShadow({ mode: "open" });
const paragraph = document.createElement("p");
paragraph.textContent = "Shadow paragraph";
shadow.append(paragraph);
</script>
<style>/* ${TEXT_TOKENS.style} */</style>
<noscript>${TEXT_TOKENS.noscript}</noscript>
<iframe title="Frame" src="/read-frame-inner"></iframe>
</body></html>
`;

// A hidden main element before an element with the main role.
const TEXT_ROLE_MAIN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.textRoleMain}</title></head>
<body>
<header><p>${TEXT_TOKENS.roleHeader}</p></header>
<main hidden><p>${TEXT_TOKENS.hiddenMain}</p></main>
<div role="main"><h1>Role main</h1><p>${TEXT_TOKENS.roleMain}</p></div>
</body></html>
`;

// No main element; a short article before a long one.
const TEXT_ARTICLE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.textArticle}</title></head>
<body>
<article><p>${TEXT_TOKENS.shortArticle}</p></article>
<article><h2>Long article</h2><p>${TEXT_TOKENS.longArticle} ${LOREM}</p><p>${LOREM}</p></article>
</body></html>
`;

// No landmarks: a sidebar of short links, a block of long paragraphs, and a text area and a
// canvas whose text, which the page does not show as text, is longer than the block.
const TEXT_BLOCK_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.textBlock}</title></head>
<body>
<div><a href="/a">${TEXT_TOKENS.sidebar}</a> <a href="/b">Docs</a></div>
<div><p>${TEXT_TOKENS.block} ${LOREM}</p><p>${LOREM}</p><p>${LOREM}</p></div>
<textarea aria-label="Notes">${TEXT_TOKENS.blockArea} ${LOREM} ${LOREM} ${LOREM} ${LOREM}</textarea>
<canvas width="10" height="10">${TEXT_TOKENS.canvas} ${LOREM} ${LOREM} ${LOREM} ${LOREM}</canvas>
</body></html>
`;

// A body whose content is hidden with content-visibility, with text directly in it and in a
// display: contents wrapper.
const TEXT_HIDDEN_BODY_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.textHiddenBody}</title></head>
<body style="content-visibility: hidden">${TEXT_TOKENS.hiddenBody}
<div style="display: contents">${TEXT_TOKENS.hiddenContents}</div>
</body></html>
`;

// A main element, a text node and a display: contents wrapper in a shadow host, the text
// assigned to a slot inside a visibility: hidden element of the closed shadow root and the
// wrapper to a slot inside a content-visibility: hidden one.
const TEXT_SLOTTED_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.textSlotted}</title></head>
<body>
<div id="host"><main slot="main"><p>${TEXT_TOKENS.slottedMain}</p></main>${TEXT_TOKENS.slottedHidden}<span slot="skipped" style="display: contents">${TEXT_TOKENS.slottedSkipped}</span></div>
<script>
document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML =
  '<slot name="main"></slot><span style="visibility: hidden"><slot></slot></span>' +
  '<div style="content-visibility: hidden"><slot name="skipped"></slot></div>';
</script>
</body></html>
`;

// Closed disclosures whose content Firefox lays out though it is hidden: one under display:
// contents holding a main element, one whose summary holds the main element, one opened only by
// an open attribute in a namespace, one whose first summary is not an HTML element, an open one
// under display: contents whose content box the page hides, and an open one under display:
// contents whose paragraph is shown.
const TEXT_DETAILS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.textDetails}</title>
<style>
@namespace fixture url(urn:fixture);
fixture|summary { display: contents; }
#styled::details-content { visibility: hidden; }
</style></head>
<body>
<details style="display: contents"><summary>${TEXT_TOKENS.detailsSummary}</summary><main><p>${TEXT_TOKENS.detailsMain}</p></main></details>
<details><summary><main><h1>Summary main</h1><p>${TEXT_TOKENS.summaryMain}</p></main></summary>${TEXT_TOKENS.summaryAnswer}<p>${TEXT_TOKENS.summaryParagraph}</p></details>
<details id="namespaced" style="display: contents"><summary>Namespaced</summary>${TEXT_TOKENS.namespacedAnswer}</details>
<details id="foreign" style="display: contents"><summary>Foreign</summary></details>
<details id="styled" open style="display: contents"><summary>Styled</summary>${TEXT_TOKENS.styledAnswer}</details>
<details open style="display: contents"><summary>Open</summary><p>${TEXT_TOKENS.openParagraph}</p></details>
<script>
document.getElementById("namespaced").setAttributeNS("urn:fixture", "open", "");
const foreign = document.createElementNS("urn:fixture", "summary");
foreign.textContent = "${TEXT_TOKENS.foreignSummary}";
document.getElementById("foreign").prepend(foreign);
</script>
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

// A page taller than the window with one solid box below the first screenful: same-coloured
// text, so read_page names it and nothing is drawn on it, and no border, shadow or outline.
const SHOT_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.shot}</title>
<style>
html, body { margin: 0; padding: 0; }
body { background: rgb(${SHOT_COLOURS.page.join(", ")}); min-height: 3000px; }
#shot-box {
  appearance: none; display: block; box-sizing: border-box;
  width: ${SHOT_BOX.width}px; height: ${SHOT_BOX.height}px;
  margin: 0; padding: 0; border: 0; border-radius: 0; outline: 0; box-shadow: none;
  background: rgb(${SHOT_COLOURS.box.join(", ")}); color: rgb(${SHOT_COLOURS.box.join(", ")});
}
</style></head>
<body><div style="padding: 1500px 0 0 40px"><button id="shot-box" type="button">Shot box</button></div></body></html>
`;

const SHOT_FIELD_STYLE = `
html, body { margin: 0; padding: 0; background: white; }
input {
  display: block; box-sizing: border-box; width: 320px; height: 44px; margin: 0 0 6px;
  padding: 0 8px; border: 2px solid rgb(128, 128, 128); border-radius: 0; outline: none;
  background: white; font: bold 24px monospace;
}
.protected { color: ${rgb(SHOT_FIELD_COLOURS.protected)}; }
`;

// Protected fields in the top document, an open shadow root, a frame from another site and a
// data: frame, each next to a plain field in a colour of its own; all in the first 500 px.
function shotFieldsPage(port: number): string {
  const protectedColour = rgb(SHOT_FIELD_COLOURS.protected);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.shotFields}</title>
<style>${SHOT_FIELD_STYLE}
.columns { display: flex; gap: 16px; padding: 8px; align-items: flex-start; }
iframe { display: block; width: 320px; height: 100px; border: 0; margin: 0 0 8px; }
#code {
  transition: all 60s; text-shadow: 3px 3px 0 ${protectedColour};
  -webkit-text-stroke: 2px ${protectedColour};
}
#code::selection { color: ${protectedColour}; }
#plain { color: ${rgb(SHOT_FIELD_COLOURS.top)}; }
#plain::selection { color: ${rgb(SHOT_FIELD_COLOURS.selection)}; }
</style></head>
<body><div class="columns"><div>
<input id="card" class="protected" autocomplete="cc-number" value="4111 1111 1111 1111" aria-label="Card number">
<input id="code" class="protected" autocomplete="one-time-code" value="492817" aria-label="One-time code">
<input id="pw" class="protected" type="password" value="MMMMWWWW" aria-label="Password">
<input id="plain" value="MMMM WWWW" aria-label="Plain">
<div id="host"></div>
</div><div>
<iframe title="Other site" src="http://localhost:${port}/shot-fields-frame"></iframe>
<iframe title="Data frame" src="data:text/html,${encodeURIComponent(shotFieldsFrame(SHOT_FIELD_COLOURS.data))}"></iframe>
</div></div>
<script>
const shadow = document.getElementById("host").attachShadow({ mode: "open" });
shadow.innerHTML = \`<style>${SHOT_FIELD_STYLE}</style>
<input class="protected" autocomplete="cc-csc" value="123" aria-label="Security code">
<input style="color: ${rgb(SHOT_FIELD_COLOURS.shadow)}" value="MMMM WWWW" aria-label="Shadow plain">\`;
</script>
</body></html>
`;
}

function shotFieldsFrame(plain: readonly number[]): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Shot fields frame</title><style>${SHOT_FIELD_STYLE}</style></head>
<body>
<input class="protected" autocomplete="cc-number" value="5555 5555 5555 4444" aria-label="Frame card number">
<input style="color: ${rgb(plain)}" value="MMMM WWWW" aria-label="Frame plain">
</body></html>
`;
}

function rgb(colour: readonly number[]): string {
  return `rgb(${colour.join(", ")})`;
}

// A frame Firefox keeps add-ons out of: its PDF viewer.
const SHOT_PDF_FRAME_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.shotPdfFrame}</title></head>
<body><iframe title="PDF" src="/shot.pdf" style="width: 400px; height: 300px"></iframe></body></html>
`;

/** A valid one-page PDF with nothing on its page. */
function minimalPdf(): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

// Three file fields, one taking several files and one with no label, a drop zone that cancels
// dragover and drop, and a button that takes no drops. The page keeps the files each target got
// in window.received and the events it saw in window.events, with the drops that reached the
// document.
const UPLOAD_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.upload}</title></head>
<body>
<main>
<input id="single" type="file" aria-label="Single file">
<input id="many" type="file" multiple aria-label="Many files">
<input id="unnamed" type="file">
<section id="zone" aria-label="Drop zone"><p>Drop files here</p></section>
<button id="plain" type="button">No drops</button>
</main>
<script>
window.received = { single: [], many: [], unnamed: [], zone: [] };
window.events = { single: [], many: [], unnamed: [], zone: [], documentDrops: 0 };
for (const id of ["single", "many", "unnamed"]) {
  const input = document.getElementById(id);
  input.addEventListener("input", () => window.events[id].push("input"));
  input.addEventListener("change", () => {
    window.events[id].push("change");
    window.received[id] = Array.from(input.files);
  });
}
const zone = document.getElementById("zone");
zone.addEventListener("dragenter", (event) => event.preventDefault());
zone.addEventListener("dragover", (event) => event.preventDefault());
zone.addEventListener("drop", (event) => {
  event.preventDefault();
  window.events.zone.push("drop");
  window.received.zone = Array.from(event.dataTransfer.files);
});
document.addEventListener("drop", () => {
  window.events.documentDrops += 1;
});
</script>
</body></html>
`;

// Elements at fixed places for click and hover, each recording what reaches it in window.log as
// "type:id", with "type:id:detail" for clicks and "type:id:pointerId:pointerType" for pointer
// presses. The toggle opens only on a mousedown followed by a mouseup, as Closure's menu
// buttons do. The menu opens on mouseenter of its trigger and closes on mouseleave. The listed
// button starts scrolled out of its scrolling box, and focus-host holds a field and plain text
// in a closed shadow root. A click focuses tabbed, editable and delegating-host's autofocus
// field, though none of them is focusable by default; it focuses neither the scrolling box in
// editable nor the one delegating-host would pass focus to by script. The root's tabindex is
// invalid, so a click on plain text still moves focus to the body.
const ACT_PAGE = `<!doctype html>
<html tabindex=""><head><meta charset="utf-8"><title>${TITLES.act}</title>
<style>
body { margin: 0; height: 3000px; font: 14px sans-serif; }
.at { position: absolute; box-sizing: border-box; width: 120px; height: 30px; margin: 0; }
</style></head>
<body>
<button id="toggle" class="at" style="left: 10px; top: 10px" aria-expanded="false">Toggle</button>
<button id="fixed" style="position: fixed; left: 150px; top: 10px; width: 120px; height: 30px; margin: 0">Fixed</button>
<button id="covered" class="at" style="left: 290px; top: 600px">Covered</button>
<div id="cover" style="position: absolute; left: 280px; top: 590px; width: 150px; height: 50px; background: rgba(0, 0, 0, 0.2)"></div>
<button id="removed" class="at" style="left: 10px; top: 60px">Removed</button>
<input id="field" class="at" style="left: 150px; top: 60px" aria-label="Field">
<button id="mouse" class="at" style="left: 290px; top: 60px">Mouse</button>
<shadow-button class="at" style="left: 10px; top: 110px; display: block"></shadow-button>
<iframe title="Inner" src="/a" style="position: absolute; left: 150px; top: 110px; width: 200px; height: 80px; border: 0"></iframe>
<button id="trigger" class="at" style="left: 10px; top: 200px">Trigger</button>
<div id="menu" style="position: absolute; left: 10px; top: 240px" hidden><button>Menu item</button></div>
<button id="elsewhere" class="at" style="left: 290px; top: 200px">Elsewhere</button>
<input id="blurred" class="at" style="left: 10px; top: 300px" aria-label="Blurred">
<p id="plain" class="at" style="left: 150px; top: 300px">Plain text</p>
<button id="held" class="at" style="left: 290px; top: 300px">Held</button>
<button id="below" class="at" style="left: 10px; top: 2000px">Below</button>
<div id="list" style="position: absolute; left: 450px; top: 10px; width: 120px; height: 40px; overflow: auto"><div style="height: 100px"></div><button id="listed" style="display: block; width: 100px; height: 30px; margin: 0">Listed</button></div>
<focus-host style="position: absolute; left: 450px; top: 60px; width: 120px; display: block"></focus-host>
<div id="tabbed" class="at" tabindex="-1" style="left: 600px; top: 10px">Tabbed</div>
<div id="editable" class="at" contenteditable="true" style="left: 600px; top: 60px"><div style="overflow: auto; white-space: nowrap; height: 30px">Editable text wider than its box</div></div>
<delegating-host style="position: absolute; left: 600px; top: 110px; width: 120px; display: block"></delegating-host>
<script>
window.log = [];
window.shadowClicks = 0;
window.events = 0;
for (const type of ["pointerover", "pointermove", "pointerdown", "mousedown"]) {
  document.addEventListener(type, () => { window.events += 1; }, true);
}
const PRESSES = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
for (const id of ["toggle", "fixed", "covered", "removed", "mouse", "below", "listed", "held"]) {
  const element = document.getElementById(id);
  for (const type of [...PRESSES, "contextmenu", "dblclick"]) {
    element.addEventListener(type, (event) => {
      if (type.startsWith("pointer")) {
        window.log.push(type + ":" + id + ":" + event.pointerId + ":" + event.pointerType);
      } else if (type.endsWith("click")) {
        window.log.push(type + ":" + id + ":" + event.detail);
      } else {
        window.log.push(type + ":" + id);
      }
    });
  }
}
const toggle = document.getElementById("toggle");
let armed = false;
toggle.addEventListener("mousedown", () => { armed = true; });
toggle.addEventListener("mouseup", () => {
  if (armed) toggle.setAttribute("aria-expanded", String(toggle.getAttribute("aria-expanded") !== "true"));
  armed = false;
});
const trigger = document.getElementById("trigger");
const menu = document.getElementById("menu");
trigger.addEventListener("mouseenter", () => { menu.hidden = false; window.log.push("mouseenter:trigger"); });
trigger.addEventListener("mouseleave", () => { menu.hidden = true; window.log.push("mouseleave:trigger"); });
document.getElementById("held").addEventListener("pointerdown", (event) => event.preventDefault());
const blurred = document.getElementById("blurred");
blurred.addEventListener("blur", () => window.log.push("blur:blurred"));
customElements.define("shadow-button", class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "closed" });
    root.innerHTML = '<button style="width: 120px; height: 30px; margin: 0">Shadow button</button>';
    root.querySelector("button").addEventListener("click", () => { window.shadowClicks += 1; });
  }
});
customElements.define("focus-host", class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "closed" });
    root.innerHTML = '<input aria-label="Inner field" style="display: block; box-sizing: border-box; width: 120px; height: 30px; margin: 0"><p style="height: 30px; margin: 0">Inner text</p>';
    window.innerField = root.querySelector("input");
    window.innerField.addEventListener("blur", () => window.log.push("blur:inner"));
  }
});
customElements.define("delegating-host", class extends HTMLElement {
  constructor() {
    super();
    window.delegatingRoot = this.attachShadow({ mode: "closed", delegatesFocus: true });
    window.delegatingRoot.innerHTML = '<p style="height: 60px; margin: 0">Delegating text</p><div autofocus style="overflow: auto; height: 20px"><div style="height: 200px"></div></div><input aria-label="Delegated field"><input aria-label="Autofocus field" autofocus>';
  }
});
</script>
</body></html>
`;

// Elements that lead to the other site (the same server under localhost), each at a fixed place,
// and a same-site link. window.clicks counts the click events that reach the document,
// window.events the pointer and mouse events before a click, and window.log the presses on the
// link whose mousedown listener rewrites its href.
function actLinksPage(port: number): string {
  const other = `http://localhost:${port}/a`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.actLinks}</title>
<style>
body { margin: 0; font: 14px sans-serif; }
.at { position: absolute; box-sizing: border-box; display: block; width: 120px; height: 30px; margin: 0; }
</style></head>
<body>
<a id="other" class="at" style="left: 10px; top: 10px" href="${other}">Other site</a>
<a id="same" class="at" style="left: 150px; top: 10px" href="/a">Same site</a>
<form action="${other}" method="get">
<input name="action" value="1" type="hidden">
<input name="getAttributeNS" value="2" type="hidden">
<button id="submit" class="at" style="left: 10px; top: 60px" type="submit">Send</button>
</form>
<label class="at" style="left: 150px; top: 60px" for="submit">Send label</label>
<svg class="at" style="left: 10px; top: 110px" width="120" height="30"><a href="${other}"><rect width="120" height="30" fill="#ccc"></rect></a></svg>
<svg class="at" style="left: 150px; top: 110px" width="120" height="30"><a><set attributeName="href" to="${other}"></set><rect width="120" height="30" fill="#ccc"></rect></a></svg>
<div class="at" style="left: 290px; top: 110px"><template shadowrootmode="closed"><svg style="position: absolute; width: 0; height: 0"><slot></slot></svg><a href="${other}"><slot></slot></a></template><span class="at" style="position: static">Continue</span></div>
<a id="rewritten" class="at" style="left: 10px; top: 160px" href="/b">Rewritten</a>
<svg class="at" style="left: 290px; top: 10px" width="120" height="30"><a xlink:href="${other}"><rect width="120" height="30" fill="#ccc"></rect></a></svg>
<svg class="at" style="left: 430px; top: 110px" width="120" height="30"><a><set attributeName="href" to="${other}" begin="click"></set><rect width="120" height="30" fill="#ccc"></rect></a></svg>
<form action="/a" method="get"><button class="at" style="left: 150px; top: 160px" type="submit" formaction="${other}">Send elsewhere</button></form>
<form id="cross" action="${other}" method="get"></form>
<a id="namespaced" class="at" style="left: 430px; top: 10px">Namespaced</a>
<a class="at" style="left: 10px; top: 2000px" href="${other}">Far other</a>
<input type="image" form="cross" alt="Image send" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" class="at" style="left: 290px; top: 160px">
<script>
window.clicks = 0;
window.events = 0;
// A same-site href in another namespace first, which getAttribute("href") would answer with.
const namespaced = document.getElementById("namespaced");
namespaced.setAttributeNS("urn:x", "href", "/a");
namespaced.setAttributeNS(null, "href", ${JSON.stringify(other)});
for (const type of ["pointerover", "pointerdown", "mousedown"]) {
  document.addEventListener(type, () => { window.events += 1; }, true);
}
window.log = [];
document.addEventListener("click", () => { window.clicks += 1; }, true);
const rewritten = document.getElementById("rewritten");
for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
  rewritten.addEventListener(type, () => window.log.push(type));
}
rewritten.addEventListener("mousedown", () => { rewritten.href = ${JSON.stringify(other)}; });
</script>
</body></html>
`;
}

// A tall page with a scrolling panel, a panel whose own wheel listener cancels the wheel, and a
// button far down. The viewport's centre is on the plain wrapper.
const ACT_SCROLL_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.actScroll}</title></head>
<body style="margin: 0">
<div style="height: 4000px">
<div id="panel" role="region" aria-label="Panel" style="position: absolute; left: 10px; top: 10px; width: 200px; height: 100px; overflow: auto"><div style="height: 1000px">Panel content</div></div>
<div id="stuck" role="region" aria-label="Stuck" style="position: absolute; left: 250px; top: 10px; width: 200px; height: 100px; overflow: auto"><div style="height: 1000px">Stuck content</div></div>
<button id="far" style="position: absolute; left: 10px; top: 3000px">Far</button>
</div>
<script>
document.getElementById("stuck").addEventListener("wheel", (event) => event.preventDefault());
</script>
</body></html>
`;

// An open modal: body's overflow hidden, which the viewport takes, so a wheel scrolls nothing.
const ACT_MODAL_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.actModal}</title></head>
<body style="margin: 0; overflow: hidden"><div style="height: 4000px">Modal page</div></body></html>
`;

// The root does not scroll and body does: the viewport takes the root's overflow, not body's.
// A link whose relative address resolves against a base on the other site.
function actBasePage(port: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.actBase}</title>
<base href="http://localhost:${port}/"></head>
<body style="margin: 0"><a href="a">Relative</a>
<svg width="100" height="30" style="position: absolute; left: 0; top: 50px"><a href=""><rect width="100" height="30"/></a></svg>
</body></html>
`;
}

// A tall page with a frame fixed over the viewport's centre.
const ACT_EMBED_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.actEmbed}</title></head>
<body style="margin: 0"><div style="height: 4000px">Embed page</div>
<iframe title="Embed" src="/a" style="position: fixed; left: 25%; top: 25%; width: 50%; height: 50%; border: 0"></iframe>
</body></html>
`;

const ACT_BODY_SCROLL_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.actBodyScroll}</title>
<style>
html { overflow: hidden; height: 100%; }
body { overflow: auto; height: 100%; margin: 0; }
</style></head>
<body><h1>Body scroll</h1><div style="height: 4000px"></div></body></html>
`;

// An item that follows the pointer while pressed and cancels its pointerdown, a draggable source
// that sets ACT_DRAG_DATA, a target that takes drops and one that does not, and a draggable item
// whose page cancels dragstart and follows the pointer instead. window.log records the drag
// events of the targets, window.pressed the mouse events of a pressed button.
const ACT_DRAG_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.actDrag}</title>
<style>
body { margin: 0; font: 14px sans-serif; }
.at { position: absolute; box-sizing: border-box; margin: 0; }
</style></head>
<body>
<div id="item" class="at" role="button" aria-label="Item" style="left: 10px; top: 10px; width: 60px; height: 30px; background: #9cf"></div>
<div id="target" class="at" role="region" aria-label="Target" style="left: 300px; top: 10px; width: 100px; height: 60px; background: #eee"></div>
<div id="source" class="at" draggable="true" role="button" aria-label="Source" style="left: 10px; top: 100px; width: 80px; height: 30px; background: #fc9"></div>
<div id="accept" class="at" role="region" aria-label="Accept" style="left: 300px; top: 100px; width: 100px; height: 60px; background: #eee"></div>
<div id="refuse" class="at" role="region" aria-label="Refuse" style="left: 450px; top: 100px; width: 100px; height: 60px; background: #eee"></div>
<div id="sortable" class="at" draggable="true" role="button" aria-label="Sortable" style="left: 10px; top: 200px; width: 60px; height: 30px; background: #9fc"></div>
<div id="slot" class="at" role="region" aria-label="Slot" style="left: 300px; top: 200px; width: 100px; height: 60px; background: #eee"></div>
<div id="far" class="at" role="button" aria-label="Far item" style="left: 10px; top: 2000px; width: 60px; height: 30px; background: #9cf"></div>
<script>
window.log = [];
window.pressed = [];
window.dropped = null;
let held = null;
for (const id of ["item", "sortable"]) {
  const element = document.getElementById(id);
  element.addEventListener("pointerdown", (event) => {
    held = { element, dx: event.clientX - element.offsetLeft, dy: event.clientY - element.offsetTop };
    if (id === "item") event.preventDefault();
  });
}
for (const type of ["mousedown", "mousemove", "mouseup"]) {
  document.addEventListener(type, (event) => {
    if (type !== "mousemove" || event.buttons !== 0) window.pressed.push(type);
  }, true);
}
document.addEventListener("pointermove", (event) => {
  if (held === null) return;
  held.element.style.left = event.clientX - held.dx + "px";
  held.element.style.top = event.clientY - held.dy + "px";
});
document.addEventListener("pointerup", () => { held = null; });
document.getElementById("sortable").addEventListener("dragstart", (event) => event.preventDefault());
document.getElementById("source").addEventListener("pointercancel", () => window.log.push("pointercancel:source"));
document.getElementById("source").addEventListener("dragstart", (event) => {
  event.dataTransfer.setData("text/plain", ${JSON.stringify(ACT_DRAG_DATA)});
});
for (const id of ["accept", "refuse"]) {
  const element = document.getElementById(id);
  for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
    element.addEventListener(type, (event) => {
      window.log.push(type + ":" + id);
      if (id === "accept" && type !== "dragleave") event.preventDefault();
      if (type === "drop") window.dropped = event.dataTransfer.getData("text/plain");
    });
  }
}
</script>
</body></html>
`;

// On load: a fetch with an Authorization header, whose response sets a cookie, then an
// XMLHttpRequest that sends the cookie back; the title says when both finished. The frame is on
// the other site (the same server under localhost) and makes a request of its own.
function networkPage(port: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.network}</title></head>
<body><h1>${TITLES.network}</h1>
<iframe title="Other site" src="http://localhost:${port}/network-frame"></iframe>
<script>
window.addEventListener("load", async () => {
  await fetch("/api/fetch", {
    headers: { Authorization: "Bearer ${NETWORK_SECRETS.bearer}", "X-Fixture": "visible" },
  });
  await new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/xhr");
    xhr.addEventListener("loadend", resolve);
    xhr.send();
  });
  document.title = "${TITLES.networkDone}";
});
</script>
</body></html>
`;
}

const NETWORK_FRAME_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Network frame</title></head>
<body><script>fetch("/api/frame");</script></body></html>
`;

function networkHopPage(port: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.networkHop}</title></head>
<body><script>location.href = "http://localhost:${port}/network-old";</script></body></html>
`;
}

// On the other site, in a frame from the fixture site: both send a beacon to the fixture site as
// they unload, which Firefox does after the next page in the tab committed.
function networkOldPage(port: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Network old page</title></head>
<body><iframe title="Fixture site" src="http://127.0.0.1:${port}/network-old-frame"></iframe>
<script>
window.addEventListener("pagehide", () => navigator.sendBeacon("http://127.0.0.1:${port}/api/beacon-top"));
</script>
</body></html>
`;
}

const NETWORK_OLD_FRAME_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Network old frame</title></head>
<body><script>
window.addEventListener("pagehide", () => navigator.sendBeacon("/api/beacon-frame"));
</script></body></html>
`;

export function counterTitle(count: number): string {
  return `${COUNTER_PREFIX}${count}`;
}

export function parseCount(title: string): number {
  const match = /^Counter ([0-9]+)$/.exec(title);
  if (match === null) throw new Error(`not a counter page title: ${JSON.stringify(title)}`);
  return Number(match[1]);
}
