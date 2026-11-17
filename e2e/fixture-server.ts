import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

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
  readEditable: "Fixture read editable",
  textMain: "Fixture text main",
  textRoleMain: "Fixture text role main",
  textArticle: "Fixture text article",
  textBlock: "Fixture text block",
  textHiddenBody: "Fixture text hidden body",
  textSlotted: "Fixture text slotted",
  textDetails: "Fixture text details",
  textShadow: "Fixture text shadow",
  textShadowMain: "Fixture text shadow main",
  textShadowArticle: "Fixture text shadow article",
  textShadowBlock: "Fixture text shadow block",
  textShadowHidden: "Fixture text shadow hidden",
  shot: "Fixture shot",
  shotFields: "Fixture shot fields",
  shotPdfFrame: "Fixture shot PDF frame",
  shotErrorFrames: "Fixture shot error frames",
  shotForeignFrames: "Fixture shot foreign frames",
  shotForeignHostile: "Fixture shot foreign hostile",
  shotForeignNested: "Fixture shot foreign nested",
  shotForeignInner: "Fixture shot foreign inner",
  shotForeignPageFrame: "Fixture shot foreign page frame",
  upload: "Fixture upload",
  act: "Fixture act",
  actLinks: "Fixture act links",
  actNewTab: "Fixture act new tab",
  actScroll: "Fixture act scroll",
  actModal: "Fixture act modal",
  actBodyScroll: "Fixture act body scroll",
  actDrag: "Fixture act drag",
  actSortable: "Fixture act sortable",
  actBase: "Fixture act base",
  actEmbed: "Fixture act embed",
  input: "Fixture input",
  inputFrames: "Fixture input frames",
  inputForms: "Fixture input forms",
  inputKeys: "Fixture input keys",
  fillForm: "Fixture fill form",
  console: "Fixture console",
  consoleCsp: "Fixture console CSP",
  consoleLoad: "Fixture console load",
  network: "Fixture network",
  networkDone: "Fixture network done",
  networkHop: "Fixture network hop",
  networkJson: "Fixture network JSON",
  networkJsonDone: "Fixture network JSON done",
  networkLogin: "Fixture network login",
  networkLoginDone: "Fixture network login done",
  networkLarge: "Fixture network large",
  networkLargeDone: "Fixture network large done",
  networkBodies: "Fixture network bodies",
  networkBodiesFrame: "Fixture network bodies frame",
  waitLate: "Fixture wait late",
  waitNavigate: "Fixture wait navigate",
  downloadLogin: "Fixture download login",
  autofill: "Fixture autofill",
  autofillFramed: "Fixture autofill framed",
  cardAutofill: "Fixture card autofill",
  beforeUnload: "Fixture before unload",
  navStart: "Fixture navigation start",
  navMiddle: "Fixture navigation middle",
  navTarget: "Fixture navigation target",
  settle: "Fixture settle",
  settleNext: "Fixture settle next",
  viewShop: "Fixture view shop",
  viewLarge: "Fixture view large",
  recordingForm: "Fixture recording form",
  longAddress: "Fixture long address",
} as const;

/** What the view shop page's status says once Add to cart is clicked. */
export const VIEW_ADDED_TEXT = "Added to cart";
/** What the view large page's status says, early in the page. */
export const VIEW_LARGE_STATUS = "Showing 3000 rows";
/** The rows of the view large page: its tree is far past read_page's 50,000 characters. */
const VIEW_LARGE_ROWS = 3000;

/** The text the settle page adds once its slow request answers. */
export const SETTLE_SLOW_TEXT = "The slow answer arrived";
/** How long the server holds the settle page's slow request, and each of its ticker's. */
export const SETTLE_SLOW_MS = 400;
/** The text the settle page adds SETTLE_LATER_MS after its Later request answers. */
export const SETTLE_LATER_TEXT = "The later answer showed";
/** How long the settle page's own timer waits after its Later request answers. */
export const SETTLE_LATER_MS = 300;
const SETTLE_TICK_MS = 30;

/** The text only the navigation target page shows. */
export const NAV_TARGET_TEXT = "Only the target page says this";

/**
 * How the navigation pages are served, given in their query: `delay` the ms the server holds the
 * target page (0 or 400), `store` its caching, cacheable but asked again (`cache`) or never
 * stored (`nostore`).
 */
export interface NavigationVariant {
  delay: 0 | 400;
  store: "cache" | "nostore";
}

/** The text the wait-late page adds, in an element with the id late, after WAIT_LATE_MS. */
export const WAIT_LATE_TEXT = "The late text has arrived";
/** How long the wait pages wait after loading before they add their text or navigate. */
export const WAIT_LATE_MS = 2000;

/** The long title page sets its title to this character repeated LONG_TITLE_CHARS times. */
export const LONG_TITLE_CHAR = "T";
export const LONG_TITLE_CHARS = 9_000_000;
/**
 * The long address page pushes its address plus `?` and this character repeated
 * LONG_ADDRESS_CHARS times. Firefox refuses an address much longer than this.
 */
export const LONG_ADDRESS_CHAR = "u";
export const LONG_ADDRESS_CHARS = 100_000;

/** What the recording form page's Log button logs, followed by a dash and the click's number. */
export const RECORDING_TOKEN = "recording-token-Hq3";

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
  loadParse: "console-load-parse-Jk3",
  loadReady: "console-load-ready-Lz4",
  loadDone: "console-load-done-Xc5",
} as const;

/** The only nonce the console CSP page's policy lets scripts run with. */
export const CONSOLE_CSP_NONCE = "fixtureNonce7Jk";

/**
 * The credentials the network page sends and gets, and the values the network JSON and login
 * pages send, which read_network must never show.
 */
export const NETWORK_SECRETS = {
  bearer: "network-bearer-Vb3Nq8",
  cookie: "network-cookie-Hs5Tz2",
  jsonName: "network-json-name-Tc6Ly3",
  jsonElement: "network-json-element-Gn2Qs8",
  jsonToken: "network-json-token-Jb5Hv1",
  /** A JSON key shaped like a value, which the name rule withholds. */
  jsonKey: "network-key@Wq5Rt",
  formJson: "network-form-json-Zp3Mc6",
  loginUser: "network-login-user-Kd7Fp2",
  loginPassword: "network-login-password-Rm4Wx9",
} as const;

/**
 * What the /api/body/ routes answer, as the server sends it before any compression: `stream` in
 * chunks some time apart, `held` its first chunk and then the rest once `releaseBody()` runs.
 */
export const NETWORK_BODIES = {
  /** 36 bytes, answered with status 500 to a POST. */
  error: '{"error":"reCAPTCHA token invalid."}',
  large: "0123456789abcdef".repeat(12_500),
  /**
   * 1,200,000 bytes in 8-byte words, each its own byte offset in 7 hex digits and a newline. Not
   * periodic, unlike `large`, whose period divides the chunk size: chunks that reach the page out
   * of order, or not at all, change its bytes.
   */
  ordered: Array.from(
    { length: 150_000 },
    (_, index) => `${(index * 8).toString(16).padStart(7, "0")}\n`,
  ).join(""),
  gzip: JSON.stringify({
    items: Array.from({ length: 300 }, (_, index) => ({ id: index, name: `item-${index}` })),
  }),
  stream: Array.from({ length: 6 }, (_, index) => `chunk ${index} ${"s".repeat(100)}\n`),
  held: ["first\n", "h".repeat(100_000)],
  other: '{"other":true}',
} as const;
/** How long /api/body/stream waits between its chunks. */
export const NETWORK_STREAM_GAP_MS = 150;

/** The cookie /download/login sets, without which /download/private.txt answers 403. */
export const DOWNLOAD_COOKIE = { name: "download_session", value: "download-cookie-Pq4Rt7" };
/** What /download/private.txt holds. */
export const DOWNLOAD_SECRET = "download-secret-Zx8Wm2";

/** The name of the cookie /api/fetch sets. */
export const NETWORK_COOKIE = "fixture_session";

/** The middle of the Log button on the console pages that have one, in CSS pixels. */
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
 * there uses, a plain field's in each context, the selected text of the top plain field, and the
 * shadow root's password field's, which a test turns into text.
 */
export const SHOT_FIELD_COLOURS = {
  protected: [201, 17, 149],
  top: [0, 128, 64],
  shadow: [160, 96, 0],
  shadowPassword: [176, 0, 48],
  frame: [0, 64, 192],
  data: [112, 48, 160],
  selection: [255, 120, 0],
} as const;

/** The test add-on's frame page, e2e/other-extension/frame.html, which hardcodes these colours. */
export const SHOT_ADDON_COLOURS = {
  frame: [255, 0, 255],
  text: [0, 255, 255],
} as const;

/** The colour of the shot-foreign pages' own frame, which nothing else there uses. */
export const SHOT_PAGE_FRAME_COLOUR = [0, 160, 0] as const;

/** A box in CSS px, relative to its document. */
export interface ShotSlot {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the test add-on puts its frames in the shot-foreign-frames page: one in a closed shadow
 * root, on the frame cover button, which holds it.
 */
export const SHOT_FOREIGN_SLOTS = {
  shadow: { left: 360, top: 28, width: 160, height: 100 },
} as const satisfies Record<string, ShotSlot>;
/** The frame cover button of the shot-foreign-frames page. */
export const SHOT_FOREIGN_COVER: ShotSlot = { left: 340, top: 8, width: 200, height: 140 };

/** Where the test add-on puts its frames in the hostile page, by what each slot is for. */
export const SHOT_HOSTILE_SLOTS = {
  shadow: { left: 340, top: 8, width: 70, height: 45 },
  transition: { left: 420, top: 8, width: 70, height: 45 },
  animation: { left: 500, top: 8, width: 70, height: 45 },
} as const satisfies Record<string, ShotSlot>;
/** How far down the hostile page's SVG filter draws a copy of everything in it, in CSS px. */
export const COPY_OFFSET = 200;

/** The shot-foreign-inner frame in the nested page, and the add-on's slot inside that frame. */
export const SHOT_NESTED = {
  inner: { left: 8, top: 60, width: 340, height: 220 },
  slot: { left: 10, top: 10, width: 120, height: 60 },
} as const satisfies Record<string, ShotSlot>;

/** The text colours of the autofill page: the login name field's fill colour, and a plain field's. */
export const AUTOFILL_COLOURS = {
  filled: [0, 96, 144],
  plain: [144, 64, 0],
} as const;
/** The login the autofill tests save for the fixture server, which Firefox fills into its page. */
export const AUTOFILL_LOGIN = { username: "WMWM MWMW", password: "pw-autofill-Jd5XqR" } as const;
/** The text colours of the card autofill page: the card number field's fill colour, and a plain field's. */
export const CARD_AUTOFILL_COLOURS = { filled: [0, 112, 64], plain: [128, 0, 96] } as const;
/** The card the card autofill tests have Firefox fill into its page, digits only as Firefox fills it. */
export const AUTOFILL_CARD = {
  name: "Ada Lovelace",
  number: "4111111111111111",
  expiryMonth: 12,
  expiryYear: 2040,
} as const;

/** What the fill-form page's password field holds when it loads. */
export const FILL_PASSWORD = "pw-fill-old-Ka3";
/** What the password field holds that the fill-form page adds when its security select changes. */
export const FILL_KEY = "psk-fill-Qw7";
/** How long the fill-form page's slow fields' listeners run, in ms: past 4 s and past 5 s. */
export const FILL_SLOW_MS = { slow: 4_200, slower: 5_200 } as const;

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
  forwardVisibility: "hidden-forward-visibility-Bt3",
  forwardContentVisibility: "hidden-forward-cv-Cu4",
  forwardDisplay: "hidden-forward-display-Dv5",
  forwardName: "hidden-forward-name-Ew6",
  forwardFallback: "hidden-forward-fallback-Fx7",
  forwardReceiverFallback: "hidden-forward-receiver-fallback-Gy8",
  legendDisplay: "hidden-legend-display-Nd1",
  legendAttribute: "hidden-legend-attribute-Oe2",
  figcaptionDisplay: "hidden-figcaption-display-Pf3",
  captionAttribute: "hidden-caption-attribute-Qg4",
  canvasLabel: "hidden-canvas-label-Ah1",
  canvasValue: "hidden-canvas-value-Bi2",
  legendCanvas: "hidden-legend-canvas-Cj3",
  legendSvg: "hidden-legend-svg-Dk4",
  buttonSvg: "hidden-button-svg-El5",
  selectText: "hidden-select-text-Fm6",
  selectLabel: "hidden-select-label-Gn7",
  selectHeading: "hidden-select-heading-Ho8",
  svgDefs: "hidden-svg-defs-Ip9",
  svgContentsTspan: "hidden-svg-contents-tspan-Jq1",
  svgLanguage: "hidden-svg-language-Kr2",
  svgSwitch: "hidden-svg-switch-Ls3",
  optionLabelled: "hidden-option-labelled-Mt4",
  optionColumn: "hidden-option-column-Nu5",
  optionSkipped: "hidden-option-skipped-Ov6",
  optionCanvas: "hidden-option-canvas-Pw7",
  optionDetails: "hidden-option-details-Qx8",
  optionListSkipped: "hidden-option-list-skipped-Ry9",
  optionDropDown: "hidden-option-dropdown-visibility-Rh5",
  optionDropDownGroup: "hidden-option-dropdown-group-Ui8",
  valueContentVisibility: "hidden-value-content-visibility-Sj6",
  selectValueContentVisibility: "hidden-select-value-content-visibility-Wl1",
  areaValueContentVisibility: "hidden-area-value-content-visibility-Xm2",
  labelContentVisibility: "hidden-label-content-visibility-Vk9",
  listBoxSelectedAttribute: "hidden-listbox-selected-attribute-Tn3",
  listBoxSelectedVisibility: "hidden-listbox-selected-visibility-Yp4",
  listBoxSelectedContentVisibility: "hidden-listbox-selected-content-visibility-Zq5",
  listBoxSelectedChild: "hidden-listbox-selected-child-Ar6",
  listBoxLabelContent: "hidden-listbox-label-content-Bs7",
  buttonValueContentVisibility: "hidden-button-value-content-visibility-Ct8",
  listBoxSelectedDisplay: "hidden-listbox-selected-display-Du9",
  listBoxSelectedGroup: "hidden-listbox-selected-group-Ev1",
  editableVisibility: "hidden-editable-visibility-Fs2",
  editableDisplay: "hidden-editable-display-Gt3",
  editableContentVisibility: "hidden-editable-content-visibility-Hu4",
  editableLabel: "hidden-editable-label-Iv5",
  editablePassword: "hidden-editable-password-Jw6",
} as const;

/**
 * Holders on the read-hidden page whose children Firefox does not render, each of which the
 * page's script gives a text node (`direct`) and a display: contents span (`contents`).
 */
export const READ_UNRENDERED = [
  "canvas",
  "object-data",
  "embed-data",
  "select",
  "optgroup",
  "svg",
  "svg-g",
  "svg-a",
  "wbr",
  "col",
  "colgroup",
  "table-column",
].map((id) => ({
  id,
  direct: `unrendered-${id}-direct-Zr5`,
  contents: `unrendered-${id}-contents-Zr5`,
}));

/** Text the read-hidden page shows in holders like those, which read_page must keep. */
export const READ_RENDERED = {
  svgText: "rendered-svg-text-Na1",
  svgLink: "rendered-svg-link-Ob2",
  foreign: "rendered-foreign-Pc3",
  objectFallback: "rendered-object-fallback-Qd4",
  embedFallback: "rendered-embed-fallback-Re5",
  wrappedOption: "rendered-wrapped-option-Sf6",
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
  shadowParagraph: "text-shadow-paragraph-Fm3",
  shellNav: "text-shell-nav-Gn4",
  shellHidden: "text-shell-hidden-Ho5",
  shellMain: "text-shell-main-Ip6",
  cardShadow: "text-card-shadow-Jq7",
  cardSlotted: "text-card-slotted-Kr8",
  shellAside: "text-shell-aside-Ls9",
  shellFooter: "text-shell-footer-Mt0",
  inlineLead: "text-inline-lead-Vc9",
  iconShadow: "text-icon-shadow-Wd0",
  innerNav: "text-inner-nav-Nu1",
  innerMain: "text-inner-main-Ov2",
  innerAfter: "text-inner-after-Pw3",
  shortPost: "text-short-post-Qx4",
  longPost: "text-long-post-Ry5",
  blockHeading: "text-block-heading-Sz6",
  slottedBlock: "text-slotted-block-Ta7",
  blockSidebar: "text-block-sidebar-Ub8",
  forwardShown: "text-forward-shown-Xe1",
  forwardHidden: "text-forward-hidden-Yf2",
  shadowSummary: "text-shadow-summary-Zg3",
  shadowAnswer: "text-shadow-answer-Ah4",
  slottedAnswer: "text-slotted-answer-Bi5",
  unassigned: "text-unassigned-Cj6",
  boxShadow: "text-box-shadow-Dk7",
  preFirst: "text-pre-first-El8",
  preSecond: "text-pre-second-Fn9",
  preShadow: "text-pre-shadow-Go0",
  lineFirst: "text-line-first-Hp1",
  lineSecond: "text-line-second-Iq2",
  canvasShadow: "text-canvas-shadow-Jr3",
  canvasSlotted: "text-canvas-slotted-Ks4",
  linkFirst: "text-link-first-Lt5",
  linkSecond: "text-link-second-Mu6",
  canvasInline: "text-canvas-inline-Nv7",
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
/** The text of the read-editable page's long editable area, past the 200-character value cut. */
export const READ_EDITABLE_LONG = "0123456789".repeat(30);

/** Page text the probe page holds, which no probe report may contain. */
export const PROBE_SECRET = "fixture-secret-7Q2xZ9kL";

// Must stay above the extension's LOAD_GRACE_MS (1000 ms, apps/extension/src/wait-for-load.ts):
// the held response is what makes the navigate test fail when the load wait returns early.
// It also keeps the console load page loading long after the console recorder starts.
const SLOW_HOLD_MS = 1500;

/**
 * How late the history-load pages answer: a read right after navigate answers then sees the
 * document the tab showed before the load of the page's address committed.
 */
export const HISTORY_LOAD_DELAY_MS = 2000;

const COUNTER_PREFIX = "Counter ";

export interface FixtureServer {
  /** The server's site, `http://127.0.0.1:<port>`, as the extension names it. */
  site: string;
  /** The server's port. */
  port: number;
  url(path: string): string;
  /** How many requests reached this path, 404s included. */
  hits(path: string): number;
  /** The headers of each request to a path under /download/, in order. */
  downloadHeaders(): IncomingHttpHeaders[];
  /**
   * Holds each request for /held-image.gif from now until the next request for
   * /autofill-framed-held, which answers the held ones; the server's close ends any still held.
   */
  holdImage(): void;
  /** Sends the rest of each /api/body/held response that has only its first chunk; `close` does too. */
  releaseBody(): void;
  close(): Promise<void>;
}

/** Serves the fixture pages on 127.0.0.1 at a free port. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const timers = new Set<NodeJS.Timeout>();
  let counter = 0;
  const hits = new Map<string, number>();
  const closedPort = await unusedPort();
  const downloadHeaders: IncomingHttpHeaders[] = [];
  const heldImages = new Set<ServerResponse>();
  let holdingImages = false;
  const heldBodies = new Set<ServerResponse>();

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path.startsWith("/download/")) downloadHeaders.push({ ...request.headers });
    if (path === "/a") {
      sendPage(response, TITLES.a);
    } else if (path === "/b") {
      sendPage(response, TITLES.b);
    } else if (path === "/long-title") {
      sendHtml(response, LONG_TITLE_PAGE);
    } else if (path === "/long-address") {
      sendHtml(response, LONG_ADDRESS_PAGE);
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
    } else if (path === "/read-editable") {
      sendHtml(response, READ_EDITABLE_PAGE);
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
    } else if (path === "/text-shadow") {
      sendHtml(response, TEXT_SHADOW_PAGE);
    } else if (path === "/text-shadow-main") {
      sendHtml(response, TEXT_SHADOW_MAIN_PAGE);
    } else if (path === "/text-shadow-article") {
      sendHtml(response, TEXT_SHADOW_ARTICLE_PAGE);
    } else if (path === "/text-shadow-block") {
      sendHtml(response, TEXT_SHADOW_BLOCK_PAGE);
    } else if (path === "/text-shadow-hidden") {
      sendHtml(response, TEXT_SHADOW_HIDDEN_PAGE);
    } else if (path === "/shot") {
      sendHtml(response, SHOT_PAGE);
    } else if (path === "/shot-fields") {
      // The frame from another site is the same server under localhost.
      sendHtml(response, shotFieldsPage(request.socket.localPort ?? 0));
    } else if (path === "/shot-fields-frame") {
      sendHtml(response, shotFieldsFrame(SHOT_FIELD_COLOURS.frame));
    } else if (path === "/shot-pdf-frame") {
      sendHtml(response, SHOT_PDF_FRAME_PAGE);
    } else if (path === "/shot-error-frames") {
      sendHtml(response, shotErrorFramesPage(closedPort));
    } else if (path === "/shot-xfo-frame") {
      sendHtml(response, SHOT_XFO_FRAME_PAGE, { "X-Frame-Options": "DENY" });
    } else if (path === "/shot-foreign-frames") {
      sendHtml(response, SHOT_FOREIGN_FRAMES_PAGE);
    } else if (path === "/shot-foreign-frames-hostile") {
      sendHtml(response, SHOT_FOREIGN_HOSTILE_PAGE);
    } else if (path === "/shot-foreign-nested") {
      sendHtml(response, SHOT_FOREIGN_NESTED_PAGE);
    } else if (path === "/shot-foreign-inner") {
      sendHtml(response, SHOT_FOREIGN_INNER_PAGE);
    } else if (path === "/shot-foreign-page-frame") {
      sendHtml(response, SHOT_FOREIGN_PAGE_FRAME_PAGE);
    } else if (path === "/shot.pdf") {
      response.writeHead(200, { "Content-Type": "application/pdf", "Cache-Control": "no-store" });
      response.end(minimalPdf());
    } else if (path === "/autofill") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      // Storable, unlike sendHtml's pages: a reload from the cache would restore the fields.
      response.end(AUTOFILL_PAGE);
    } else if (path === "/autofill-unload" || path === "/autofill-post") {
      // Its form posts here, so it is also the page a form sent with POST.
      request.resume();
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      // Storable, as /autofill, and kept out of the back-forward cache by its unload listener.
      response.end(AUTOFILL_UNLOAD_PAGE);
    } else if (path === "/autofill-moving") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(AUTOFILL_MOVING_PAGE);
    } else if (path === "/autofill-framed") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      // The frame from another site is the same server under localhost.
      response.end(autofillFramedPage(request.socket.localPort ?? 0));
    } else if (path === "/autofill-framed-unload") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      // Storable, and kept out of the back-forward cache by its unload listener.
      response.end(
        autofillFramedPage(request.socket.localPort ?? 0, "/autofill-frame", UNLOAD_SCRIPT),
      );
    } else if (path === "/autofill-framed-held" || path === "/autofill-framed-stop") {
      // Storable, as /autofill-framed-unload. The page's request answers the held images, so the
      // step's load can finish while Foxleash's load of the page's address is under way, as a slow
      // page's load does, and Foxleash's load gets its own image at once.
      if (path === "/autofill-framed-held") {
        holdingImages = false;
        for (const held of heldImages) sendHeldImage(held);
        heldImages.clear();
      }
      const port = request.socket.localPort ?? 0;
      const script = path === "/autofill-framed-held" ? HELD_IMAGE : STOP_SCRIPT;
      const timer = setTimeout(() => {
        timers.delete(timer);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(autofillFramedPage(port, "/autofill-frame", UNLOAD_SCRIPT + script));
      }, HISTORY_LOAD_DELAY_MS);
      timers.add(timer);
    } else if (path === "/held-image.gif") {
      if (holdingImages) {
        heldImages.add(response);
        response.on("close", () => heldImages.delete(response));
      } else {
        sendHeldImage(response);
      }
    } else if (path === "/autofill-frame" || path === "/autofill-frame-post") {
      // Its form posts here, so it is also the frame a form sent with POST.
      request.resume();
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(AUTOFILL_FRAME_PAGE);
    } else if (path === "/card-autofill") {
      sendHtml(response, CARD_AUTOFILL_PAGE);
    } else if (path === "/upload") {
      sendHtml(response, UPLOAD_PAGE);
    } else if (path === "/act") {
      sendHtml(response, ACT_PAGE);
    } else if (path === "/act-links") {
      // The other site is the same server under localhost.
      sendHtml(response, actLinksPage(request.socket.localPort ?? 0));
    } else if (path === "/act-new-tab") {
      sendHtml(response, ACT_NEW_TAB_PAGE);
    } else if (path === "/act-scroll") {
      sendHtml(response, ACT_SCROLL_PAGE);
    } else if (path === "/act-modal") {
      sendHtml(response, ACT_MODAL_PAGE);
    } else if (path === "/act-body-scroll") {
      sendHtml(response, ACT_BODY_SCROLL_PAGE);
    } else if (path === "/act-drag") {
      sendHtml(response, ACT_DRAG_PAGE);
    } else if (path === "/act-sortable") {
      sendHtml(response, ACT_SORTABLE_PAGE);
    } else if (path === "/act-base") {
      // Relative links resolve against the other site.
      sendHtml(response, actBasePage(request.socket.localPort ?? 0));
    } else if (path === "/act-embed") {
      sendHtml(response, ACT_EMBED_PAGE);
    } else if (path === "/input") {
      // The other site is the same server under localhost.
      sendHtml(response, inputPage(request.socket.localPort ?? 0));
    } else if (path === "/input-frames") {
      sendHtml(response, INPUT_FRAMES_PAGE);
    } else if (path === "/input-forms") {
      // The other site is the same server under localhost.
      sendHtml(response, inputFormsPage(request.socket.localPort ?? 0));
    } else if (path === "/input-keys") {
      sendHtml(response, INPUT_KEYS_PAGE);
    } else if (path === "/fill-form") {
      // The other site is the same server under localhost.
      sendHtml(response, fillFormPage(request.socket.localPort ?? 0));
    } else if (path === "/settle") {
      sendHtml(response, SETTLE_PAGE);
    } else if (path === "/settle-next") {
      sendPage(response, TITLES.settleNext);
    } else if (path === "/settle/slow" || path === "/settle/tick") {
      // Delays come from the server: a hidden tab runs the page's own timers about once a second.
      const timer = setTimeout(
        () => {
          timers.delete(timer);
          response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
          response.end("ok");
        },
        path === "/settle/slow" ? SETTLE_SLOW_MS : SETTLE_TICK_MS,
      );
      timers.add(timer);
    } else if (path === "/settle/later") {
      response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end("ok");
    } else if (path === "/view-shop") {
      sendHtml(response, VIEW_SHOP_PAGE);
    } else if (path === "/view-large") {
      sendHtml(response, viewLargePage());
    } else if (path === "/view-away") {
      // To the same server under another site, which the tests never approve.
      response.writeHead(302, { Location: `http://localhost:${request.socket.localPort}/a` });
      response.end();
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
    } else if (path === "/recording-form") {
      sendHtml(response, RECORDING_FORM_PAGE);
    } else if (path === "/console-csp") {
      sendHtml(response, CONSOLE_CSP_PAGE, {
        "Content-Security-Policy": `script-src 'nonce-${CONSOLE_CSP_NONCE}'`,
      });
    } else if (path === "/console-load") {
      sendHtml(response, CONSOLE_LOAD_PAGE);
    } else if (path === "/console-load-hold.js") {
      const timer = setTimeout(() => {
        timers.delete(timer);
        sendHtml(response, "", { "Content-Type": "text/javascript; charset=utf-8" });
      }, SLOW_HOLD_MS);
      timers.add(timer);
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
    } else if (path === "/network-json") {
      sendHtml(response, NETWORK_JSON_PAGE);
    } else if (path === "/network-login") {
      sendHtml(response, NETWORK_LOGIN_PAGE);
    } else if (path === "/network-login-post") {
      request.resume();
      sendPage(response, TITLES.networkLoginDone);
    } else if (path === "/network-large") {
      sendHtml(response, NETWORK_LARGE_PAGE);
    } else if (
      path === "/api/json" ||
      path === "/api/form-json" ||
      path === "/api/json-at-limit" ||
      path === "/api/json-over-limit"
    ) {
      request.resume();
      response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end("ok");
    } else if (path === "/network-bodies") {
      // The frame from another site is the same server under localhost.
      sendHtml(response, networkBodiesPage(request.socket.localPort ?? 0));
    } else if (path === "/network-bodies-frame") {
      sendPage(response, TITLES.networkBodiesFrame);
    } else if (path.startsWith("/api/body/")) {
      request.resume();
      sendBody(path, response, request.socket.localPort ?? 0);
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
    } else if (path === "/download/receipt.pdf") {
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="Receipt-1234.pdf"',
        "Cache-Control": "no-store",
      });
      response.end(receiptPdf());
    } else if (path === "/download/data.bin") {
      // A type Firefox only saves: a PDF it also opens in a new tab once downloaded.
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="data.bin"',
        "Cache-Control": "no-store",
      });
      response.end("data");
    } else if (path === "/download/login") {
      sendPage(response, TITLES.downloadLogin, {
        "Set-Cookie": `${DOWNLOAD_COOKIE.name}=${DOWNLOAD_COOKIE.value}; Path=/`,
      });
    } else if (path === "/download/private.txt") {
      const cookie = `${DOWNLOAD_COOKIE.name}=${DOWNLOAD_COOKIE.value}`;
      const signedIn = (request.headers.cookie ?? "").split("; ").includes(cookie);
      response.writeHead(signedIn ? 200 : 403, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      response.end(signedIn ? DOWNLOAD_SECRET : "forbidden");
    } else if (path === "/download/away") {
      // To the same server under another site, which the tests never approve.
      response.writeHead(302, {
        Location: `http://localhost:${request.socket.localPort}/download/receipt.pdf`,
      });
      response.end();
    } else if (path === "/download/same") {
      response.writeHead(302, { Location: "/download/receipt.pdf" });
      response.end();
    } else if (path === "/before-unload") {
      sendHtml(response, BEFORE_UNLOAD_PAGE);
    } else if (path === "/counter") {
      counter += 1;
      sendPage(response, counterTitle(counter));
    } else if (path === "/nav/held-image") {
      // Holds the middle page's load past its DOM ready, so a click lands on a page still loading.
      const timer = setTimeout(() => {
        timers.delete(timer);
        response.writeHead(200, { "Content-Type": "image/gif", "Cache-Control": "no-store" });
        response.end(Buffer.from(PIXEL_GIF, "base64"));
      }, NAV_IMAGE_HOLD_MS);
      timers.add(timer);
    } else if (NAVIGATION_PAGES.includes(path)) {
      sendNavigationPage(response, path, navigationVariant(request.url), timers);
    } else if (path === "/counter-no-cache") {
      // Cached, but a load asks again; a history load shows the cached copy.
      sendPage(response, counterTitle(hits.get(path) ?? 0), { "Cache-Control": "no-cache" });
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
    downloadHeaders: () => [...downloadHeaders],
    holdImage: () => {
      holdingImages = true;
    },
    releaseBody,
    close: async () => {
      releaseBody();
      for (const response of heldImages) {
        if (!response.destroyed && !response.writableEnded) response.end();
      }
      heldImages.clear();
      holdingImages = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };

  /** Answers an /api/body/ request, from either site; every answer may be read by another site. */
  function sendBody(path: string, response: ServerResponse, port: number): void {
    const headers = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
    if (path === "/api/body/error") {
      response.writeHead(500, { ...headers, "Content-Type": "application/json" });
      response.end(NETWORK_BODIES.error);
    } else if (path === "/api/body/large") {
      response.writeHead(200, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      response.end(NETWORK_BODIES.large);
    } else if (path === "/api/body/ordered-json") {
      response.writeHead(200, { ...headers, "Content-Type": "application/json" });
      response.end(NETWORK_BODIES.ordered);
    } else if (path === "/api/body/ordered-binary") {
      response.writeHead(200, { ...headers, "Content-Type": "application/octet-stream" });
      response.end(NETWORK_BODIES.ordered);
    } else if (path === "/api/body/gzip") {
      response.writeHead(200, {
        ...headers,
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      });
      response.end(gzipSync(NETWORK_BODIES.gzip));
    } else if (path === "/api/body/stream") {
      response.writeHead(200, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      const chunks = [...NETWORK_BODIES.stream];
      const next = (): void => {
        const chunk = chunks.shift();
        if (chunk === undefined || response.destroyed) {
          response.end();
          return;
        }
        response.write(chunk);
        const timer = setTimeout(() => {
          timers.delete(timer);
          next();
        }, NETWORK_STREAM_GAP_MS);
        timers.add(timer);
      };
      next();
    } else if (path === "/api/body/held") {
      response.writeHead(200, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      response.write(NETWORK_BODIES.held[0]);
      heldBodies.add(response);
    } else if (path === "/api/body/other") {
      response.writeHead(200, { ...headers, "Content-Type": "application/json" });
      response.end(NETWORK_BODIES.other);
    } else if (path === "/api/body/redirect") {
      response.writeHead(302, {
        ...headers,
        Location: `http://localhost:${port}/api/body/other?by=redirect`,
      });
      response.end();
    } else {
      response.writeHead(404, headers);
      response.end();
    }
  }

  function releaseBody(): void {
    for (const response of heldBodies) {
      if (!response.destroyed && !response.writableEnded) response.end(NETWORK_BODIES.held[1]);
    }
    heldBodies.clear();
  }
}

/** Answers a /held-image.gif request with the pixel; a response already closed is left alone. */
function sendHeldImage(response: ServerResponse): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(200, { "Content-Type": "image/gif", "Cache-Control": "no-store" });
  response.end(Buffer.from(PIXEL_GIF, "base64"));
}

const NAVIGATION_PAGES: readonly string[] = ["/nav/start", "/nav/middle", "/nav/target"];
export const NAV_IMAGE_HOLD_MS = 3000;
const PIXEL_GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Sends a navigation page, the target after the variant's delay; 404 for another query. */
function sendNavigationPage(
  response: ServerResponse,
  path: string,
  variant: NavigationVariant | undefined,
  timers: Set<NodeJS.Timeout>,
): void {
  if (variant === undefined) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  const send = () =>
    sendHtml(response, navigationPage(path, variant), {
      "Cache-Control": variant.store === "cache" ? "no-cache" : "no-store",
    });
  if (path !== "/nav/target" || variant.delay === 0) {
    send();
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(timer);
    send();
  }, variant.delay);
  timers.add(timer);
}

/** The variant a navigation page's URL asks for, or undefined for any other query. */
function navigationVariant(url: string | undefined): NavigationVariant | undefined {
  const query = new URL(url ?? "/", "http://127.0.0.1").searchParams;
  const delay = query.get("delay");
  const store = query.get("store");
  if ((delay !== "0" && delay !== "400") || (store !== "cache" && store !== "nostore")) {
    return undefined;
  }
  return { delay: delay === "0" ? 0 : 400, store };
}

/** The start, middle or target page of the navigation tests, linking on in the same variant. */
function navigationPage(path: string, { delay, store }: NavigationVariant): string {
  const query = `delay=${delay}&amp;store=${store}`;
  const target = `/nav/target?${query}`;
  const page = (title: string, body: string) =>
    `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body><main><h1>${title}</h1>\n${body}</main></body></html>\n`;
  if (path === "/nav/target") return page(TITLES.navTarget, `<p>${NAV_TARGET_TEXT}</p>`);
  if (path === "/nav/middle") {
    return page(
      TITLES.navMiddle,
      `<p><a href="${target}">Go to target</a></p>\n<img src="/nav/held-image" alt="" width="1" height="1">`,
    );
  }
  return page(
    TITLES.navStart,
    `<p><a href="${target}">Go to target</a></p>
<p><a href="/nav/middle?${query}">Go to middle</a></p>
<form action="/nav/target" method="get">
<input type="hidden" name="delay" value="${delay}"><input type="hidden" name="store" value="${store}">
<label>Search <input name="q"></label> <button type="submit">Search</button>
</form>
<p><a href="#far">Jump down</a></p>
<p><button type="button" onclick="history.pushState(null, '', '/nav/start?${query}&amp;pushed=1')">Push state</button></p>
<p><a href="/api/beacon-top">No content</a></p>
<p><a href="/download/data.bin">Save data</a></p>
<div style="height: 3000px"></div>
<p id="far">Far down the start page</p>`,
  );
}

/** A port on 127.0.0.1 that nothing listened on a moment ago. */
async function unusedPort(): Promise<number> {
  const probe = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", resolve);
  await promise;
  const address: AddressInfo | string | null = probe.address();
  const closed = Promise.withResolvers<void>();
  probe.close(() => closed.resolve());
  await closed.promise;
  if (address === null || typeof address === "string") {
    throw new Error("the probe server has no TCP address");
  }
  return address.port;
}

function sendPage(
  response: ServerResponse,
  title: string,
  headers: Record<string, string> = {},
): void {
  sendHtml(
    response,
    `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body><h1>${title}</h1></body></html>\n`,
    headers,
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

// The console pages with a Log button log only when it is clicked, so a test can wait until
// Foxleash records the page first.
const CONSOLE_LOG_BUTTON = `<button id="log" style="position: fixed; left: 10px; top: 10px; width: 120px; height: 40px; margin: 0">Log</button>`;

const LONG_TITLE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<script>document.title = ${JSON.stringify(LONG_TITLE_CHAR)}.repeat(${LONG_TITLE_CHARS});</script>
</head>
<body><p>A page with a very long title</p></body></html>
`;

const LONG_ADDRESS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.longAddress}</title>
<script>
const query = ${JSON.stringify(LONG_ADDRESS_CHAR)}.repeat(${LONG_ADDRESS_CHARS});
history.pushState(null, "", "/long-address?" + query);
</script>
</head>
<body><p>A page with a very long address</p></body></html>
`;

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

const BEFORE_UNLOAD_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.beforeUnload}</title></head>
<body><h1>${TITLES.beforeUnload}</h1>
<script>
window.onbeforeunload = (event) => {
  event.preventDefault();
  event.returnValue = "";
};
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

// Each Log click logs the token with its number; each Fetch click fetches /api/fetch?n= its number.
const RECORDING_FORM_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.recordingForm}</title></head>
<body><h1>${TITLES.recordingForm}</h1>
<form>
<label>First name <input id="first"></label>
<label>Last name <input id="last"></label>
<label>Notes <textarea id="notes"></textarea></label>
</form>
<button id="log" type="button">Log</button>
<button id="fetch" type="button">Fetch</button>
<script>
let logged = 0;
let fetched = 0;
document.getElementById("log").addEventListener("click", () => {
  logged += 1;
  console.log("${RECORDING_TOKEN}-" + logged);
});
document.getElementById("fetch").addEventListener("click", () => {
  fetched += 1;
  fetch("/api/fetch?n=" + fetched);
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

// The held script keeps the page loading well past the recorder's start.
const CONSOLE_LOAD_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.consoleLoad}</title></head>
<body><h1>${TITLES.consoleLoad}</h1>
<script src="/console-load-hold.js"></script>
<script>
console.log("${CONSOLE_TOKENS.loadParse}");
document.addEventListener("DOMContentLoaded", () => console.log("${CONSOLE_TOKENS.loadReady}"));
window.addEventListener("load", () => console.log("${CONSOLE_TOKENS.loadDone}"));
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
// button (one of them hidden until then), a show-password button whose page-world listener
// turns the toggled field into text, and enough content below to scroll the page, which the
// script does.
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
<button id="show-password" type="button">Show password</button>
<input id="bare" type="password" value="${READ_SECRETS.bare}">
<div id="later" hidden><input id="hidden-password" type="password" aria-label="Hidden password" value="${READ_SECRETS.hidden}"></div>
<button type="submit">Sign in</button>
</form>
<div style="height: 3000px">Below the form</div>
</main>
<script>
document.getElementById("password-script").value = "${READ_SECRETS.passwordScript}";
document.getElementById("show-password").addEventListener("click", () => {
  document.getElementById("toggle").type = "text";
});
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

// A 10 by 10 SVG image, which an object or embed shows as its data.
const SVG_DATA_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3Crect width='10' height='10'/%3E%3C/svg%3E";

// Text hidden in each way a page can hide it: display none, the hidden attribute, aria-hidden,
// inert, visibility hidden, content-visibility hidden, video fallback, and in disclosures: a
// closed one, one whose open attribute is in a namespace, one whose first summary is not HTML,
// and open ones whose ::details-content box is hidden, or that are hidden themselves, also
// inside a heading's name and in a button's; and a hidden details in another namespace, which
// has no content box, whose ::details-content rule asks for visible text. Two open disclosures
// and one whose content box is visible inside a hidden details show their text. Each details is
// on one line, with no whitespace inside it. Then holders whose children Firefox does not
// render (canvas fallback, an object and an embed showing their data, a drop-down select and its
// optgroup, SVG outside its text elements, wbr, column boxes), which the script fills with text
// and display: contents spans, as text a page hides there; a field in a canvas, legends and a
// button with text in a canvas or an svg, a select the script adds text, a label and a heading
// to, SVG text in defs, in a display: contents tspan, under a language test or in a switch, an
// option whose label stands for its content, and options a list box does not render (in a
// column-box optgroup, a content-visibility: hidden optgroup, a canvas and an open details with
// a hidden content box that the script appends, a content-visibility: hidden list box). Each is
// in a block of its own. Last, the same holders where Firefox shows what they hold: a canvas
// whose aria-label names its button, SVG text and a link in it, a foreignObject, an object
// without data, an embed without a source, and an option the script wraps in a div in its select.
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
#list-details::details-content { content-visibility: hidden; }
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
<div><canvas width="1" height="1" data-unrendered="canvas"></canvas></div>
<div><object data="${SVG_DATA_URL}" type="image/svg+xml" width="10" height="10" data-unrendered="object-data"></object></div>
<div><embed src="${SVG_DATA_URL}" type="image/svg+xml" width="10" height="10" data-unrendered="embed-data"></div>
<div><select aria-label="Unrendered pick" data-unrendered="select"><option>Unrendered choice</option></select></div>
<div><select aria-label="Unrendered group pick"><optgroup label="Group" data-unrendered="optgroup"><option>Grouped choice</option></optgroup></select></div>
<div><svg width="10" height="10" data-unrendered="svg"></svg></div>
<div><svg width="10" height="10"><g data-unrendered="svg-g"></g></svg></div>
<div><svg width="10" height="10"><a href="/a" data-unrendered="svg-a"></a></svg></div>
<p>Word<wbr data-unrendered="wbr">break</p>
<table><colgroup data-unrendered="colgroup"><col data-unrendered="col"></colgroup><tr><td>Column cell</td></tr></table>
<div style="display: table"><div style="display: table-column" data-unrendered="table-column"></div><div style="display: table-cell">Styled column cell</div></div>
<div><label for="canvas-field" style="display: none">${READ_HIDDEN.canvasLabel}</label><canvas width="1" height="1"><input id="canvas-field" value="${READ_HIDDEN.canvasValue}"></canvas></div>
<fieldset><legend>Billing<canvas width="1" height="1">${READ_HIDDEN.legendCanvas}</canvas></legend><input aria-label="Billing field"></fieldset>
<fieldset><legend>Card<svg width="0" height="0">${READ_HIDDEN.legendSvg}</svg></legend><input aria-label="Card field"></fieldset>
<div><button>Delete<svg width="0" height="0">${READ_HIDDEN.buttonSvg}</svg></button></div>
<div><select id="select-text" aria-label="Plan"><option>Free</option></select></div>
<div><select id="select-appended" aria-label="Plan two"><option>Free two</option></select></div>
<div><svg width="200" height="40"><defs><text>${READ_HIDDEN.svgDefs}</text></defs><text x="0" y="15"><tspan style="display: contents">${READ_HIDDEN.svgContentsTspan}</tspan></text></svg></div>
<div><svg width="200" height="20"><text x="0" y="15" systemLanguage="zz">${READ_HIDDEN.svgLanguage}</text></svg></div>
<div><svg width="200" height="20"><switch><text x="0" y="15">${READ_HIDDEN.svgSwitch}</text></switch></svg></div>
<div><select aria-label="Labelled pick"><option label="Labelled free">${READ_HIDDEN.optionLabelled}</option></select></div>
<div><select id="select-list" size="3" aria-label="List pick"><optgroup label="Column group" style="display: table-column-group"><option>${READ_HIDDEN.optionColumn}</option></optgroup><optgroup label="Skipped group" style="content-visibility: hidden"><option>${READ_HIDDEN.optionSkipped}</option></optgroup><option>List choice</option></select></div>
<div><select size="2" aria-label="Skipped list pick" style="content-visibility: hidden"><option>${READ_HIDDEN.optionListSkipped}</option></select></div>
<div><button><canvas aria-label="Chart" width="1" height="1"></canvas></button></div>
<div><svg width="200" height="20"><text x="0" y="15">${READ_RENDERED.svgText}</text></svg></div>
<div><svg width="200" height="20"><text x="0" y="15"><a href="/a">${READ_RENDERED.svgLink}</a></text></svg></div>
<div><svg width="200" height="40"><foreignObject width="200" height="40"><p>${READ_RENDERED.foreign}</p></foreignObject></svg></div>
<div><object><p>${READ_RENDERED.objectFallback}</p></object></div>
<div><embed id="embed-fallback"></div>
<div><select id="select-wrapper" aria-label="Wrapper pick"><option>Plain choice</option></select></div>
<script>
const unrendered = ${JSON.stringify(Object.fromEntries(READ_UNRENDERED.map(({ id, direct, contents }) => [id, [direct, contents]])))};
for (const holder of document.querySelectorAll("[data-unrendered]")) {
  const [direct, contents] = unrendered[holder.getAttribute("data-unrendered")];
  const span = document.createElement("span");
  span.style.display = "contents";
  span.textContent = contents;
  holder.append(" " + direct + " ", span);
}
document.getElementById("select-text").prepend("${READ_HIDDEN.selectText}");
for (const [name, token] of [
  ["label", "${READ_HIDDEN.selectLabel}"],
  ["h2", "${READ_HIDDEN.selectHeading}"],
]) {
  const appended = document.createElement(name);
  appended.style.display = "contents";
  appended.textContent = token;
  document.getElementById("select-appended").append(appended);
}
document.getElementById("embed-fallback").append("${READ_RENDERED.embedFallback}");
const listCanvas = document.createElement("canvas");
listCanvas.append(new Option("${READ_HIDDEN.optionCanvas}"));
document.getElementById("select-list").append(listCanvas);
const listDetails = document.createElement("details");
listDetails.id = "list-details";
listDetails.open = true;
listDetails.append(new Option("${READ_HIDDEN.optionDetails}"));
document.getElementById("select-list").append(listDetails);
const wrapper = document.createElement("div");
const wrapped = document.createElement("option");
wrapped.textContent = "${READ_RENDERED.wrappedOption}";
wrapper.append(wrapped);
document.getElementById("select-wrapper").append(wrapper);
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
// Then two components that pass their light content through slots into a nested component's
// slot, hiding some of it on the passing slot: as text, and inside a button. A third passes on
// only an empty slot, so the nested slot's own fallback is not shown.
const READ_SHADOW_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.readShadow}</title></head>
<body>
<open-widget>Slotted open text</open-widget>
<closed-widget>Slotted closed text</closed-widget>
<p><relay-outer><span slot="shown">Forwarded text</span>${READ_HIDDEN.forwardVisibility}<span slot="boxed" style="display: contents">${READ_HIDDEN.forwardContentVisibility}</span><span slot="gone" style="display: contents">${READ_HIDDEN.forwardDisplay}</span></relay-outer></p>
<p><relay-outer button><span slot="shown">Forwarded button</span>${READ_HIDDEN.forwardName}</relay-outer></p>
<p><relay-empty></relay-empty></p>
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
customElements.define("relay-inner", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "closed" }).innerHTML =
      "<slot>${READ_HIDDEN.forwardReceiverFallback}</slot>";
  }
});
customElements.define("relay-outer", class extends HTMLElement {
  constructor() {
    super();
    const relay =
      '<relay-inner><slot name="shown"></slot><slot style="visibility: hidden"></slot>' +
      '<slot name="boxed" style="display: block; content-visibility: hidden"></slot>' +
      '<slot name="gone" style="display: none"></slot>' +
      '<slot name="unfilled" style="visibility: hidden">${READ_HIDDEN.forwardFallback}</slot>' +
      "</relay-inner>";
    this.attachShadow({ mode: "closed" }).innerHTML = this.hasAttribute("button")
      ? "<button>" + relay + "</button>"
      : relay;
  }
});
customElements.define("relay-empty", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "closed" }).innerHTML = "<relay-inner><slot></slot></relay-inner>";
  }
});
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
// assigned nodes, a canvas, a div in a canvas, an object and an embed showing their data, a
// drop-down select, an svg, an svg g, a wbr, a col, a display: table-column div; showing ones: a
// plain div, an open details, a slot, a slot showing its fallback, an object without data, an
// embed without a source, a foreignObject), buttons and options named from their content (one
// button the test moves into a canvas, an SVG one into defs, an option into a div in its select
// and one into an hr in its select), fields, editable areas, fieldsets, a figure and a table
// whose name sources or values the test changes and hides, button inputs whose value the test
// changes and hides, ones whose legend, figcaption, caption or label is hidden from the start, a
// visibility: hidden drop-down and list boxes with a visible option, a list box with hidden
// selected options, a selected option with a hidden child and a labelled one, drop-downs whose
// selected option or its child is hidden or whose label attribute is empty, fields with their own
// content-visibility: hidden, and custom elements with open shadow roots.
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
<div role="group" aria-label="Canvas root" id="root-canvas">Canvas root text</div>
<div role="group" aria-label="Deep canvas root" id="root-canvas-deep">Deep canvas root text</div>
<div role="group" aria-label="Object data root" id="root-object-data">Object data root text</div>
<div role="group" aria-label="Embed data root" id="root-embed-data">Embed data root text</div>
<div role="group" aria-label="Select root" id="root-select">Select root text</div>
<div role="group" aria-label="Svg root" id="root-svg">Svg root text</div>
<div role="group" aria-label="Svg group root" id="root-svg-g">Svg group root text</div>
<div role="group" aria-label="Word break root" id="root-wbr">Word break root text</div>
<div role="group" aria-label="Column root" id="root-col">Column root text</div>
<div role="group" aria-label="Table column root" id="root-table-column">Table column root text</div>
<div role="group" aria-label="Object fallback root" id="root-object-fallback">Object fallback root text</div>
<div role="group" aria-label="Embed fallback root" id="root-embed-fallback">Embed fallback root text</div>
<div role="group" aria-label="Foreign object root" id="root-svg-foreign">Foreign object root text</div>
<div role="group" aria-label="Boxed canvas root" id="root-canvas-boxed">Boxed canvas root text</div>
<div role="group" aria-label="Boxed deep canvas root" id="root-canvas-deep-boxed">Boxed deep canvas root text</div>
<div role="group" aria-label="Boxed object fallback root" id="root-object-fallback-boxed">Boxed object fallback root text</div>
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
<canvas id="holder-canvas" width="1" height="1"></canvas>
<canvas width="1" height="1"><div id="holder-canvas-deep"></div></canvas>
<object id="holder-object-data" data="${SVG_DATA_URL}" type="image/svg+xml" width="10" height="10"></object>
<embed id="holder-embed-data" src="${SVG_DATA_URL}" type="image/svg+xml" width="10" height="10">
<select id="holder-select" aria-label="Holder pick"><option>Holder choice</option></select>
<svg id="holder-svg" width="10" height="10"></svg>
<svg width="10" height="10"><g id="holder-svg-g"></g></svg>
<p>Word<wbr id="holder-wbr">break</p>
<table><colgroup><col id="holder-col"></colgroup><tr><td>Column holder cell</td></tr></table>
<div style="display: table"><div id="holder-table-column" style="display: table-column"></div><div style="display: table-cell">Styled column holder cell</div></div>
<object id="holder-object-fallback"></object>
<embed id="holder-embed-fallback">
<svg width="200" height="40"><foreignObject id="holder-svg-foreign" width="200" height="40"></foreignObject></svg>
<svg width="10" height="10"><defs id="holder-defs"></defs></svg>
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
<button id="button-canvas"><span id="button-canvas-label">Go canvas</span></button>
<svg width="100" height="20"><g id="button-defs" role="button"><text id="button-defs-label" x="0" y="15">Go defs</text></g></svg>
<select id="select-wrapped" aria-label="Wrapped pick"><option>Wrapped one</option><option id="option-wrapped">Wrapped two</option></select>
<select id="select-rule" aria-label="Rule pick"><option>Rule one</option><option id="option-in-rule">Rule two</option></select>
<fieldset id="fieldset-hidden"><legend id="legend-hidden">Hidden legend</legend><input aria-label="Hidden legend field"></fieldset>
<figure id="figure-hidden"><p>Hidden figure body</p><figcaption id="figcaption-hidden">Hidden figcaption</figcaption></figure>
<table id="table-hidden"><caption id="caption-hidden">Hidden caption</caption><tr><td>Hidden table cell</td></tr></table>
<details id="details-legend" open><summary>Legend holder</summary><fieldset><legend id="legend-closed">Closed legend</legend></fieldset></details>
<label id="label-wrapping">Wrapped name <input id="input-wrapped"></label>
<label id="label-both" for="textarea-both">Both name</label><textarea id="textarea-both"></textarea>
<label id="label-invisible" for="input-invisible">Invisible name</label><input id="input-invisible">
<label id="label-kept" for="input-kept">Kept name</label><input id="input-kept">
<input id="input-value-hidden" aria-label="Hidden value" value="Start">
<input id="input-value-invisible" aria-label="Invisible value" value="Start">
<textarea id="textarea-value-hidden" aria-label="Hidden area">Start</textarea>
<select id="select-value-hidden" aria-label="Hidden value pick"><option id="option-value-hidden">Eleven</option><option>Twelve</option></select>
<input id="input-password-hidden" type="password" aria-label="Hidden password field">
<input id="input-value-shown" aria-label="Shown value" value="Start">
<div id="editable-wrap-hidden"><div id="editable-value-hidden" contenteditable="true" aria-label="Hidden editable">Start</div></div>
<div id="editable-value-shown" contenteditable="true" aria-label="Shown editable">Start</div>
<input type="submit" id="input-button-hidden" value="Send hidden">
<input type="submit" id="input-button-invisible" value="Send invisible">
<input type="submit" id="input-button-shown" value="Send shown">
<fieldset id="fieldset-shown"><legend id="legend-shown">Shown legend</legend><input aria-label="Shown legend field"></fieldset>
<fieldset><legend style="display: none">${READ_HIDDEN.legendDisplay}</legend><input aria-label="Static legend field"></fieldset>
<fieldset><legend hidden>${READ_HIDDEN.legendAttribute}</legend><input aria-label="Static legend attribute field"></fieldset>
<figure><p>Static figure body</p><figcaption style="display: none">${READ_HIDDEN.figcaptionDisplay}</figcaption></figure>
<table><caption hidden>${READ_HIDDEN.captionAttribute}</caption><tr><td>Static table cell</td></tr></table>
<select id="select-dropdown-hidden" aria-label="Hidden drop-down pick" style="visibility: hidden"><option>Drop one</option><option id="option-dropdown-hidden" style="visibility: visible">${READ_HIDDEN.optionDropDown}</option><optgroup label="Drop group" style="visibility: visible"><option style="visibility: visible">${READ_HIDDEN.optionDropDownGroup}</option></optgroup></select>
<select size="2" aria-label="Hidden list pick" style="visibility: hidden"><option>List one</option><option style="visibility: visible">Shown list choice</option></select>
<select multiple aria-label="Hidden multiple pick" style="visibility: hidden"><option>Multiple one</option><option style="visibility: visible">Shown multiple choice</option></select>
<select multiple aria-label="Shown list value"><option selected>Shown list value one</option><option id="option-list-value-child" selected>Shown list value two</option><option selected label="Shown row label">${READ_HIDDEN.listBoxLabelContent}</option><option selected hidden>${READ_HIDDEN.listBoxSelectedAttribute}</option><option selected style="visibility: hidden">${READ_HIDDEN.listBoxSelectedVisibility}</option><option selected style="content-visibility: hidden">${READ_HIDDEN.listBoxSelectedContentVisibility}</option><option selected style="display: none">${READ_HIDDEN.listBoxSelectedDisplay}</option><optgroup label="Hidden selection group" style="content-visibility: hidden"><option selected>${READ_HIDDEN.listBoxSelectedGroup}</option></optgroup></select>
<select aria-label="Drawn hidden pick"><option>Drawn other</option><option selected hidden>Drawn hidden choice</option></select>
<select aria-label="Drawn child pick"><option>Drawn child other</option><option id="option-drawn-child" selected>Drawn child</option></select>
<select aria-label="Drawn empty label pick"><option>Drawn empty other</option><option selected label="">Drawn empty label text</option></select>
<input id="input-cv-value" aria-label="Content hidden note" value="${READ_HIDDEN.valueContentVisibility}" style="content-visibility: hidden">
<input type="button" id="input-cv-button" title="Content hidden button" value="${READ_HIDDEN.buttonValueContentVisibility}" style="content-visibility: hidden">
<select id="select-cv-value" aria-label="Content hidden pick" style="content-visibility: hidden"><option>${READ_HIDDEN.selectValueContentVisibility}</option></select>
<textarea id="textarea-cv-value" aria-label="Content hidden area" style="content-visibility: hidden">${READ_HIDDEN.areaValueContentVisibility}</textarea>
<label for="input-cv-label" style="display: none">${READ_HIDDEN.labelContentVisibility}</label><input id="input-cv-label" title="Content hidden label field" style="content-visibility: hidden">
<label for="input-hidden-label" style="display: none">Hidden label name</label><input id="input-hidden-label">
<script>
const hiddenChild = document.createElement("span");
hiddenChild.hidden = true;
hiddenChild.textContent = "${READ_HIDDEN.listBoxSelectedChild}";
document.getElementById("option-list-value-child").append(hiddenChild);
const drawnTail = document.createElement("span");
drawnTail.hidden = true;
drawnTail.textContent = " drawn tail";
document.getElementById("option-drawn-child").append(drawnTail);
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

// Editable areas: one with an explicit textbox role and its text in blocks, one longer than the
// value cut, one with hidden and labelled parts, one with content-visibility: hidden, an empty
// one, one holding an editable element with its own textbox role, and one holding form fields.
const READ_EDITABLE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.readEditable}</title></head>
<body>
<div id="message" role="textbox" contenteditable="true" aria-label="Message Body"><div>Hello Ann,</div><div>See you <b>soon</b>.</div></div>
<div id="long" contenteditable="true" aria-label="Long">${READ_EDITABLE_LONG}</div>
<div id="partly" contenteditable="true" aria-label="Partly hidden">Shown part <span aria-label="${READ_HIDDEN.editableLabel}">with a label</span><span style="visibility: hidden"> ${READ_HIDDEN.editableVisibility}</span><span style="display: none"> ${READ_HIDDEN.editableDisplay}</span></div>
<div id="content-hidden" contenteditable="true" aria-label="Content hidden editable" style="content-visibility: hidden">${READ_HIDDEN.editableContentVisibility}</div>
<div id="empty" contenteditable="true" aria-label="Empty"></div>
<div id="outer" contenteditable="true" aria-label="Outer">Outer text <span role="textbox" title="Inner">inner text</span></div>
<div id="fields" contenteditable="true" aria-label="With fields">Note <input aria-label="Inner field" value="Field text"><input type="password" aria-label="Inner password" value="${READ_HIDDEN.editablePassword}"><textarea aria-label="Inner area">Area text</textarea><select aria-label="Inner pick"><option>Pick text</option></select></div>
</body></html>
`;

const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

// A main element among a header, an aside with a filled form and a footer, then, directly in the
// body, text that is shown (a text node, a display: contents wrapper, the shadow-root paragraph
// of a display: contents shadow host) and text that is not: hidden, the text of form fields, a
// closed disclosure's content and that host's unslotted text, script, style and noscript source,
// and a frame.
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
paragraph.textContent = "${TEXT_TOKENS.shadowParagraph}";
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

// An app shell whose closed shadow root shows a header, a hidden paragraph and a footer around a
// slot that the page's main element and aside are assigned to. Inside main, a sentence holds an
// inline web component and a hidden line break, two links each hold a block, and a card shows
// its shadow root's paragraph and its slotted text.
const TEXT_SHADOW_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.textShadow}</title></head>
<body>
<app-shell><main><h1>Shell main</h1><p>${TEXT_TOKENS.shellMain} ${LOREM}</p><p>${TEXT_TOKENS.inlineLead} <b>bold</b><br style="display: none"> <text-icon></text-icon>.</p><a href="/a"><div>${TEXT_TOKENS.linkFirst}</div></a><a href="/b"><div>${TEXT_TOKENS.linkSecond}</div></a><text-card>${TEXT_TOKENS.cardSlotted}</text-card></main><aside><p>${TEXT_TOKENS.shellAside}</p></aside></app-shell>
<script>
customElements.define("text-icon", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = '<span>${TEXT_TOKENS.iconShadow}</span>';
  }
});
customElements.define("text-card", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = '<p>${TEXT_TOKENS.cardShadow}</p><slot></slot>';
  }
});
customElements.define("app-shell", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "closed" }).innerHTML =
      '<header><p>${TEXT_TOKENS.shellNav}</p></header><p style="display: none">${TEXT_TOKENS.shellHidden}</p>' +
      '<div><slot></slot></div><footer><p>${TEXT_TOKENS.shellFooter}</p></footer>';
  }
});
</script>
</body></html>
`;

// A main element after a nav inside a closed shadow root, and a paragraph after its host.
const TEXT_SHADOW_MAIN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.textShadowMain}</title></head>
<body>
<inner-main></inner-main>
<p>${TEXT_TOKENS.innerAfter}</p>
<script>
customElements.define("inner-main", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "closed" }).innerHTML =
      '<nav><p>${TEXT_TOKENS.innerNav}</p></nav><main><p>${TEXT_TOKENS.innerMain} ${LOREM}</p></main>';
  }
});
</script>
</body></html>
`;

// No main element; a short article, then a long one inside a closed shadow root.
const TEXT_SHADOW_ARTICLE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.textShadowArticle}</title></head>
<body>
<article><p>${TEXT_TOKENS.shortPost}</p></article>
<post-view></post-view>
<script>
customElements.define("post-view", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "closed" }).innerHTML =
      '<article><h2>Post</h2><p>${TEXT_TOKENS.longPost} ${LOREM}</p><p>${LOREM}</p></article>';
  }
});
</script>
</body></html>
`;

// No landmarks: a sidebar of short links, and a host whose long paragraphs are slotted into its
// shadow root under a heading of the shadow root's own.
const TEXT_SHADOW_BLOCK_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.textShadowBlock}</title></head>
<body>
<div><a href="/a">${TEXT_TOKENS.blockSidebar}</a> <a href="/b">Docs</a></div>
<block-view><p>${TEXT_TOKENS.slottedBlock} ${LOREM}</p><p>${LOREM}</p></block-view>
<script>
customElements.define("block-view", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = '<h2>${TEXT_TOKENS.blockHeading}</h2><slot></slot>';
  }
});
</script>
</body></html>
`;

// Shadow trees that hide text: a slot passed on to another slot and hidden there, an open
// disclosure whose content box is hidden, a host whose light text no slot shows, and in the
// shadow root of a canvas's fallback a main element holding text beside a filled slot, then an
// inline element; then a pre and a pre-line paragraph, each holding a web component: both keep
// their line breaks, the pre also its blank line and the indent an inline block starts with.
const TEXT_SHADOW_HIDDEN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.textShadowHidden}</title></head>
<body>
<forward-outer><span slot="shown">${TEXT_TOKENS.forwardShown}</span>${TEXT_TOKENS.forwardHidden}</forward-outer>
<details-box>${TEXT_TOKENS.slottedAnswer}</details-box>
<plain-box>${TEXT_TOKENS.unassigned}</plain-box>
<canvas width="10" height="10"><canvas-tag><b>${TEXT_TOKENS.canvasSlotted}</b></canvas-tag></canvas>
<pre>${TEXT_TOKENS.preFirst}

<span style="display: inline-block">  ${TEXT_TOKENS.preSecond}</span> <pre-tag></pre-tag></pre>
<p style="white-space: pre-line">${TEXT_TOKENS.lineFirst}
  ${TEXT_TOKENS.lineSecond} <pre-tag></pre-tag></p>
<script>
customElements.define("forward-inner", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "closed" }).innerHTML = "<slot></slot>";
  }
});
customElements.define("forward-outer", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "closed" }).innerHTML =
      '<forward-inner><slot name="shown"></slot><slot style="visibility: hidden"></slot></forward-inner>';
  }
});
customElements.define("details-box", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML =
      "<style>details::details-content { visibility: hidden; }</style>" +
      '<details open><summary>${TEXT_TOKENS.shadowSummary}</summary>${TEXT_TOKENS.shadowAnswer}<slot></slot></details>';
  }
});
customElements.define("plain-box", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = '<p>${TEXT_TOKENS.boxShadow}</p>';
  }
});
customElements.define("canvas-tag", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML =
      '<main><div>${TEXT_TOKENS.canvasShadow}<slot></slot></div></main><span>${TEXT_TOKENS.canvasInline}</span>';
  }
});
customElements.define("pre-tag", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = '<span>${TEXT_TOKENS.preShadow}</span>';
  }
});
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
// data: frame, each next to a plain field in a colour of its own; the shadow root also holds a
// password field with no protecting token; all in the first 500 px. The shadow password's type is
// written in capitals on purpose: the `type` property lowercases it, the attribute does not.
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
<input style="color: ${rgb(SHOT_FIELD_COLOURS.shadow)}" value="MMMM WWWW" aria-label="Shadow plain">
<input id="shadow-pw" type="PASSWORD" style="color: ${rgb(SHOT_FIELD_COLOURS.shadowPassword)}" value="MMMMWWWW" aria-label="Shadow password">\`;
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

// A login form Firefox fills with a saved login on load. Firefox forces `color` on an autofilled
// field, not its fill colour. The plain field outside the form is the control.
const AUTOFILL_PAGE = autofillPage("/autofill-done", "");

// Keeps a page out of the back-forward cache, so going back to it loads it again.
const UNLOAD_SCRIPT = '<script>addEventListener("unload", () => {});</script>\n';

// An image the server holds open while holdImage() is on.
const HELD_IMAGE = '<img src="/held-image.gif" alt="">\n';

// Going back or forward to the page, once it has loaded, it stops every load in its tab every 5 ms
// (after load, so the step's own frame still loads and gets its value back).
const STOP_SCRIPT = `<script>if (performance.getEntriesByType("navigation")[0]?.type === "back_forward") {
  addEventListener("load", () => {
    sessionStorage.setItem("stopping", "yes");
    setInterval(() => window.stop(), 5);
  });
}</script>
`;

// The same form, which posts to /autofill-post, on a page an unload listener keeps out of the
// back-forward cache.
const AUTOFILL_UNLOAD_PAGE = autofillPage("/autofill-post", UNLOAD_SCRIPT);

// The same form, which posts to /autofill-frame-post, for the frame of /autofill-framed-unload.
const AUTOFILL_FRAME_PAGE = autofillPage("/autofill-frame-post", "");

// The unload page, which also changes its address with the History API when going back or forward
// loads it again, as some pages do while they load.
const AUTOFILL_MOVING_PAGE = autofillPage(
  "/autofill-post",
  `<script>addEventListener("unload", () => {});
if (performance.getEntriesByType("navigation")[0]?.type === "back_forward") {
  history.replaceState(null, "", location.href + "&moved");
}</script>
`,
);

function autofillPage(action: string, script: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.autofill}</title>
<style>${SHOT_FIELD_STYLE}
#login-name { -webkit-text-fill-color: ${rgb(AUTOFILL_COLOURS.filled)}; }
#plain-name { color: ${rgb(AUTOFILL_COLOURS.plain)}; }
</style></head>
<body>
<form action="${action}" method="post">
<label for="login-name">Login name</label>
<input id="login-name" type="text">
<label for="password">Password</label>
<input id="password" type="password">
<button type="submit">Sign in</button>
</form>
<label for="plain-name">Plain name</label>
<input id="plain-name" type="text" value="MMMM WWWW">
${script}</body></html>
`;
}

// An autofill page, /autofill unless given, in a frame from another site.
function autofillFramedPage(port: number, framePath = "/autofill?frame", script = ""): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.autofillFramed}</title></head>
<body><iframe title="Login frame" src="http://localhost:${port}${framePath}"></iframe>${script}</body></html>
`;
}

// A card form Firefox's form autofill identifies from its labels: no field has an autocomplete
// token. Firefox forces `color` on an autofilled field, so the card number's colour is a
// `-webkit-text-fill-color`. The plain field outside the form is the control.
const CARD_AUTOFILL_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.cardAutofill}</title>
<style>${SHOT_FIELD_STYLE}
#card-number { -webkit-text-fill-color: ${rgb(CARD_AUTOFILL_COLOURS.filled)}; }
#plain-name { color: ${rgb(CARD_AUTOFILL_COLOURS.plain)}; }
</style></head>
<body>
<form action="/a" method="post">
<label for="card-name">Name on card</label>
<input id="card-name" type="text">
<label for="card-number">Card number</label>
<input id="card-number" type="text">
<label for="card-expiry">Expiry</label>
<input id="card-expiry" type="text" placeholder="MM/YY">
<button type="submit">Pay</button>
</form>
<label for="plain-name">Plain name</label>
<input id="plain-name" type="text" value="MMMM WWWW">
</body></html>
`;

// A frame Firefox keeps add-ons out of: its PDF viewer.
const SHOT_PDF_FRAME_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.shotPdfFrame}</title></head>
<body><iframe title="PDF" src="/shot.pdf" style="width: 400px; height: 300px"></iframe></body></html>
`;

// A frame whose response refuses to be framed and one whose load fails, both showing Firefox's
// error page; their query strings are escaped in the error page's address.
function shotErrorFramesPage(closedPort: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.shotErrorFrames}</title>
<style>${SHOT_FIELD_STYLE}
iframe { display: block; width: 320px; height: 100px; border: 0; margin: 0 0 8px; }
#plain { color: ${rgb(SHOT_FIELD_COLOURS.top)}; }
</style></head>
<body>
<input id="card" class="protected" autocomplete="cc-number" value="4111 1111 1111 1111" aria-label="Card number">
<input id="plain" value="MMMM WWWW" aria-label="Plain">
<iframe title="Refused frame" src="/shot-xfo-frame?a=1&amp;b=c+d"></iframe>
<iframe title="Unreachable frame" src="http://127.0.0.1:${closedPort}/?x=1&amp;y=a+b"></iframe>
</body></html>
`;
}

const SHOT_XFO_FRAME_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Shot XFO frame</title></head>
<body><p>Not shown in a frame.</p></body></html>
`;

// The shot-foreign pages: the test add-on in e2e/other-extension fills each data-addon-slot
// element with a frame of its own page. Everything is placed absolutely in the first 600 x 450 px.
const SHOT_FOREIGN_STYLE = `${SHOT_FIELD_STYLE}
.at { position: absolute; }
#card { left: 8px; top: 8px; }
#plain { left: 8px; top: 58px; color: ${rgb(SHOT_FIELD_COLOURS.top)}; }
#page-frame { display: block; left: 8px; top: 120px; width: 120px; height: 80px; border: 0; margin: 0; }
[data-addon-slot] { z-index: 1; }
`;

const SHOT_FOREIGN_FIELDS = `<input id="card" class="at protected" autocomplete="cc-number" value="4111 1111 1111 1111" aria-label="Card number">
<input id="plain" class="at" value="MMMM WWWW" aria-label="Plain">
<iframe id="page-frame" class="at" title="Page frame" src="/shot-foreign-page-frame"></iframe>`;

// A solid button below the add-on's frame, with same-coloured text, so what lies behind the
// hidden frame is known and read_page names it.
const SHOT_FOREIGN_FRAMES_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.shotForeignFrames}</title>
<style>${SHOT_FOREIGN_STYLE}
#frame-cover {
  appearance: none; ${at(SHOT_FOREIGN_COVER)}; z-index: 0; box-sizing: border-box;
  margin: 0; padding: 0; border: 0; border-radius: 0; outline: 0; box-shadow: none;
  background: ${rgb(SHOT_COLOURS.box)}; color: ${rgb(SHOT_COLOURS.box)};
}
</style></head>
<body>${SHOT_FOREIGN_FIELDS}
<button id="frame-cover" class="at" type="button">Frame cover</button>
<div class="at" data-addon-slot="shadow" style="${at(SHOT_FOREIGN_SLOTS.shadow)}"></div>
</body></html>
`;

// Page styles aimed at showing the add-on's frames despite the hiding sheet: a long transition,
// an animation that keeps them shown (on another frame, so it cannot hide a missing transition
// override), and an SVG filter on the body that draws a copy of everything COPY_OFFSET px lower.
const SHOT_FOREIGN_HOSTILE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.shotForeignHostile}</title>
<style>${SHOT_FOREIGN_STYLE}
html { background: white; }
body { position: relative; width: 600px; height: 450px; background: transparent; filter: url(#copy); }
#slot-transition > iframe { transition: all 60s; }
#slot-animation > iframe, #page-frame {
  will-change: opacity, visibility; animation: keep-shown 1s infinite;
}
@keyframes keep-shown { from, to { visibility: visible; opacity: 1; } }
</style></head>
<body>${SHOT_FOREIGN_FIELDS}
<div class="at" data-addon-slot="shadow" style="${at(SHOT_HOSTILE_SLOTS.shadow)}"></div>
<div id="slot-transition" class="at" data-addon-slot="iframe" style="${at(SHOT_HOSTILE_SLOTS.transition)}"></div>
<div id="slot-animation" class="at" data-addon-slot="iframe" style="${at(SHOT_HOSTILE_SLOTS.animation)}"></div>
<svg width="0" height="0" style="position: absolute"><filter id="copy" filterUnits="userSpaceOnUse" x="0" y="0" width="1000" height="1000" color-interpolation-filters="sRGB">
<feOffset in="SourceGraphic" dx="0" dy="${COPY_OFFSET}" result="copy"/>
<feMerge><feMergeNode in="copy"/><feMergeNode in="SourceGraphic"/></feMerge>
</filter></svg>
</body></html>
`;

// The add-on's frame in a subframe; the top document holds that subframe and the page's frame.
const SHOT_FOREIGN_NESTED_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.shotForeignNested}</title>
<style>${SHOT_FOREIGN_STYLE}
#plain { top: 8px; }
#inner { display: block; ${at(SHOT_NESTED.inner)}; border: 0; margin: 0; }
#page-frame { left: 360px; top: 60px; width: 200px; height: 150px; }
</style></head>
<body><input id="plain" class="at" value="MMMM WWWW" aria-label="Plain">
<iframe id="inner" class="at" title="Inner frame" src="/shot-foreign-inner"></iframe>
<iframe id="page-frame" class="at" title="Page frame" src="/shot-foreign-page-frame"></iframe>
</body></html>
`;

const SHOT_FOREIGN_INNER_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.shotForeignInner}</title>
<style>${SHOT_FIELD_STYLE}
.at { position: absolute; }
#inner-plain { left: 10px; top: 80px; color: ${rgb(SHOT_FIELD_COLOURS.frame)}; }
#inner-card { left: 10px; top: 130px; }
</style></head>
<body><div class="at" data-addon-slot="shadow" style="${at(SHOT_NESTED.slot)}"></div>
<input id="inner-plain" class="at" value="MMMM WWWW" aria-label="Inner plain">
<input id="inner-card" class="at protected" autocomplete="cc-number" value="5555 5555 5555 4444" aria-label="Inner card number">
</body></html>
`;

const SHOT_FOREIGN_PAGE_FRAME_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.shotForeignPageFrame}</title>
<style>html, body { margin: 0; height: 100%; background: ${rgb(SHOT_PAGE_FRAME_COLOUR)}; }</style></head>
<body></body></html>
`;

/** A box as CSS declarations for an absolutely placed element. */
function at({ left, top, width, height }: ShotSlot): string {
  return `left: ${left}px; top: ${top}px; width: ${width}px; height: ${height}px`;
}

/** What /download/receipt.pdf serves. */
export function receiptPdf(): string {
  return minimalPdf();
}

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

// Four file fields, one taking several files, one with no label and one with an explicit textbox
// role, a drop zone that cancels dragover and drop, and a button that takes no drops. The page
// keeps the files each target got in window.received and the events it saw in window.events, with
// the drops that reached the document.
const UPLOAD_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.upload}</title></head>
<body>
<main>
<input id="single" type="file" aria-label="Single file">
<input id="many" type="file" multiple aria-label="Many files">
<input id="unnamed" type="file">
<input id="typed" type="file" role="textbox" aria-label="Typed file">
<section id="zone" aria-label="Drop zone"><p>Drop files here</p></section>
<button id="plain" type="button">No drops</button>
</main>
<script>
window.received = { single: [], many: [], unnamed: [], typed: [], zone: [] };
window.events = { single: [], many: [], unnamed: [], typed: [], zone: [], documentDrops: 0 };
for (const id of ["single", "many", "unnamed", "typed"]) {
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

// Quiet does nothing; Slow adds a paragraph once its request answers; Later adds one in the page's
// own timer SETTLE_LATER_MS after its request answers, as a shop page that shows the cart count
// 300 ms after its fetch answers, and records in window.laterMs how late that timer ran (unlike
// the other buttons it uses a page timer on purpose: a hidden tab runs it only after about a
// second); Ticker starts a chain of requests that never ends, each changing the count.
const SETTLE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.settle}</title></head>
<body>
<button id="quiet">Quiet</button>
<button id="slow">Slow</button>
<button id="later">Later</button>
<button id="ticker">Ticker</button>
<a href="/settle-next">Next page</a>
<p id="count">0</p>
<div id="out"></div>
<script>
document.getElementById("quiet").addEventListener("click", () => {});
document.getElementById("slow").addEventListener("click", async () => {
  await (await fetch("/settle/slow")).text();
  const answer = document.createElement("p");
  answer.textContent = ${JSON.stringify(SETTLE_SLOW_TEXT)};
  document.getElementById("out").append(answer);
});
document.getElementById("later").addEventListener("click", async () => {
  await (await fetch("/settle/later")).text();
  const answered = performance.now();
  setTimeout(() => {
    window.laterMs = Math.round(performance.now() - answered);
    const answer = document.createElement("p");
    answer.textContent = ${JSON.stringify(SETTLE_LATER_TEXT)};
    document.getElementById("out").append(answer);
  }, ${SETTLE_LATER_MS});
});
document.getElementById("ticker").addEventListener("click", async () => {
  for (let ticks = 1; ; ticks += 1) {
    await (await fetch("/settle/tick")).text();
    document.getElementById("count").textContent = String(ticks);
  }
});
</script>
</body></html>
`;

// A small shop page: Add to cart changes the cart link and fills the status region; Compare
// changes nothing; the partner link leads, through a redirect, to a site the tests never approve.
const VIEW_SHOP_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.viewShop}</title></head>
<body>
<header>
<a href="/view-shop">Lumen Lamps</a>
<nav aria-label="Categories"><a href="/view-shop?c=desk">Desk lamps</a> <a href="/view-shop?c=floor">Floor lamps</a></nav>
<a id="cart" href="/view-shop?cart">Cart (0)</a>
</header>
<main>
<h1>Brass desk lamp</h1>
<p>Price: 420 kr</p>
<p>In stock: 5</p>
<button id="add">Add to cart</button>
<button id="compare">Compare</button>
<a href="/view-away">Partner offer</a>
<div role="status" id="status"></div>
</main>
<footer><p>Lumen Lamps, a fixture shop</p></footer>
<script>
document.getElementById("add").addEventListener("click", () => {
  document.getElementById("cart").textContent = "Cart (1)";
  document.getElementById("status").textContent = ${JSON.stringify(VIEW_ADDED_TEXT)};
});
document.getElementById("compare").addEventListener("click", () => {});
</script>
</body></html>
`;

/**
 * A page whose tree runs far past read_page's cut: landmarks, headings, a form and a status region
 * first, then thousands of rows with a link in every fiftieth.
 */
function viewLargePage(): string {
  const rows: string[] = [];
  for (let index = 1; index <= VIEW_LARGE_ROWS; index += 1) {
    const number = String(index).padStart(4, "0");
    rows.push(
      index % 50 === 0
        ? `<li><a href="/a">Row ${number} details</a></li>`
        : `<li>Row ${number} lorem ipsum dolor sit amet</li>`,
    );
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.viewLarge}</title></head>
<body>
<header><nav aria-label="Site"><a href="/a">Home</a> <a href="/b">About</a></nav></header>
<main>
<h1>${TITLES.viewLarge}</h1>
<form aria-label="Filter"><label>Name <input id="name"></label> <button type="button">Filter</button></form>
<div role="status">${VIEW_LARGE_STATUS}</div>
<section aria-label="Rows"><h2>Rows</h2><ul>
${rows.join("\n")}
</ul></section>
</main>
<footer><p>The end of the rows</p></footer>
</body></html>
`;
}

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
<form action="${other}" method="get"><button id="plain-submit" class="at" style="left: 290px; top: 60px">Plain send</button></form>
<svg class="at" style="left: 10px; top: 110px" width="120" height="30"><a href="${other}"><rect width="120" height="30" fill="#ccc"></rect></a></svg>
<svg class="at" style="left: 150px; top: 110px" width="120" height="30"><a><set attributeName="href" to="${other}"></set><rect width="120" height="30" fill="#ccc"></rect></a></svg>
<div class="at" style="left: 290px; top: 110px"><template shadowrootmode="closed"><svg style="position: absolute; width: 0; height: 0"><slot></slot></svg><a href="${other}"><slot></slot></a></template><span class="at" style="position: static">Continue</span></div>
<a id="rewritten" class="at" style="left: 10px; top: 160px" href="/b">Rewritten</a>
<svg class="at" style="left: 290px; top: 10px" width="120" height="30"><a xlink:href="${other}"><rect width="120" height="30" fill="#ccc"></rect></a></svg>
<svg class="at" style="left: 430px; top: 110px" width="120" height="30"><a><set attributeName="href" to="${other}" begin="click"></set><rect width="120" height="30" fill="#ccc"></rect></a></svg>
<form action="/a" method="get"><button class="at" style="left: 150px; top: 160px" type="submit" formaction="${other}">Send elsewhere</button></form>
<form id="cross" action="${other}" method="get"></form>
<a id="namespaced" class="at" style="left: 430px; top: 10px">Namespaced</a>
<a id="mail" class="at" style="left: 10px; top: 210px" href="mailto:someone@example.org?body=x">Mail link</a>
<form method="post" enctype="text/plain" action="mailto:someone@example.org"><input name="body" value="x" type="hidden"><button id="mail-send" class="at" style="left: 150px; top: 210px" type="submit">Mail send</button></form>
<a id="script" class="at" style="left: 290px; top: 210px" href="javascript:void(window.jsClicks = (window.jsClicks || 0) + 1)">Script link</a>
<a id="blob" class="at" style="left: 430px; top: 210px">Blob link</a>
<a class="at" style="left: 10px; top: 2000px" href="${other}">Far other</a>
<input type="image" form="cross" alt="Image send" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" class="at" style="left: 290px; top: 160px">
<script>
window.clicks = 0;
window.events = 0;
document.getElementById("blob").href = URL.createObjectURL(new Blob(["x"], { type: "text/plain" }));
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

// A same-site link and a same-site form that open their page in a new tab.
const ACT_NEW_TAB_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.actNewTab}</title></head>
<body>
<p><a href="/a" target="_blank">New tab</a></p>
<form action="/a" method="get" target="_blank"><input name="q" aria-label="New tab query"><button type="submit">Send new tab</button></form>
</body></html>
`;

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

// A link, an SVG link with an empty href, a form button and a buttonless form whose relative
// addresses resolve against a base on the other site.
function actBasePage(port: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.actBase}</title>
<base href="http://localhost:${port}/"></head>
<body style="margin: 0"><a href="a">Relative</a>
<svg width="100" height="30" style="position: absolute; left: 0; top: 50px"><a href=""><rect width="100" height="30"/></a></svg>
<form action="a" method="get" style="position: absolute; left: 0; top: 100px"><button type="submit">Based send</button></form>
<form action="a" method="get" style="position: absolute; left: 0; top: 150px"><input aria-label="Based field" name="q"></form>
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

/**
 * Fields for type: plain ones, ones in a shadow root and a contenteditable, React-style
 * controlled inputs, fields whose scripts undo trusted input, and a field of a form that posts
 * to another site.
 */
function inputPage(port: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.input}</title></head>
<body>
<input id="plain" aria-label="Plain" value="Hello">
<textarea id="area" aria-label="Area">Line</textarea>
<div id="editable" contenteditable="true" aria-label="Editable">Start</div>
<div id="paragraphs" contenteditable="true" aria-label="Paragraphs"><p id="first" role="group" aria-label="First paragraph">One</p><p id="second" role="group" aria-label="Second paragraph">Two</p></div>
<input id="subject" aria-label="Subject">
<div id="compose" contenteditable="true" aria-label="Compose"><div id="compose-top"><br></div><div id="signature">-- Signature</div></div>
<div id="reply" contenteditable="true" aria-label="Reply"><div id="greeting">Hi Ann,</div><div id="reply-line"><br></div><div id="reply-signature">-- Signature</div></div>
<div id="compose-lines" contenteditable="true" aria-label="Compose lines"><div id="compose-lines-top"><br></div><div id="compose-lines-signature">-- Signature</div></div>
<div id="selected" contenteditable="true" aria-label="Selected">Hello world, bye</div>
<div id="island-host" contenteditable="true" aria-label="Island"><span id="island" contenteditable="false">Fixed</span> text</div>
<div id="shadow-host"></div>
<input id="email" type="email" aria-label="Email" value="a@b.c">
<input id="number" type="number" aria-label="Number" value="12">
<input id="full" aria-label="Full" maxlength="3" value="abc">
<input id="short" aria-label="Short" maxlength="5" value="ab">
<input id="react" aria-label="React" value="">
<input id="react-frozen" aria-label="React frozen" value="Fixed">
<input id="untrusting" aria-label="Untrusting" value="Keep">
<div id="untrusting-editable" contenteditable="true" aria-label="Untrusting editable">Keep</div>
<div id="wandering" contenteditable="true" aria-label="Wandering editable">Keep</div>
<div id="selecting" contenteditable="true" aria-label="Selecting editable">Keep</div>
<input id="consumer" aria-label="Consumer" value="">
<input id="disabled" aria-label="Disabled" value="Off" disabled>
<input id="readonly" aria-label="Read only" value="Fixed" readonly>
<div id="block" role="group" aria-label="Plain block">Text</div>
<form id="away" action="http://localhost:${port}/a" method="get"><input id="away-field" aria-label="Away field" name="q"></form>
<script>
window.submits = 0;
document.addEventListener("submit", () => { window.submits += 1; }, true);
const shadow = document.getElementById("shadow-host").attachShadow({ mode: "open" });
shadow.innerHTML = '<input id="shadow-field" aria-label="Shadow field" value="In">';
window.shadowField = shadow.getElementById("shadow-field");
// React's value tracking: an own value property whose setter records the value; an input event
// is a change only when the value differs from the recorded one, and the value is set back to the
// component's state afterwards.
window.reactState = {};
function controlled(input, accepts) {
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  let tracked = native.get.call(input);
  let state = tracked;
  window.reactState[input.id] = state;
  Object.defineProperty(input, "value", {
    configurable: true,
    get() { return native.get.call(this); },
    set(value) { tracked = String(value); native.set.call(this, value); },
  });
  input.addEventListener("input", () => {
    const now = native.get.call(input);
    if (now !== tracked) {
      tracked = now;
      if (accepts) state = now;
      window.reactState[input.id] = state;
    }
    input.value = state;
  });
}
controlled(document.getElementById("react"), true);
controlled(document.getElementById("react-frozen"), false);
// A page that stops the browser's own input event before anything sees it, and undoes it.
const untrusting = document.getElementById("untrusting");
const untrustingEditable = document.getElementById("untrusting-editable");
const wandering = document.getElementById("wandering");
const selecting = document.getElementById("selecting");
window.addEventListener("input", (event) => {
  if (!event.isTrusted) return;
  if (event.target === untrusting) {
    event.stopImmediatePropagation();
    untrusting.value = "Keep";
  } else if (event.target === untrustingEditable) {
    event.stopImmediatePropagation();
    untrustingEditable.textContent = "Keep";
  } else if (event.target === wandering) {
    event.stopImmediatePropagation();
    wandering.textContent = "Keep";
  } else if (event.target === selecting) {
    event.stopImmediatePropagation();
    selecting.textContent = "Keep";
  }
}, true);
// An editor that moves the caret away when it gets beforeinput.
wandering.addEventListener("beforeinput", (event) => {
  if (!event.isTrusted) getSelection().collapse(document.getElementById("block"), 0);
});
// An editor that selects the "ee" of "Keep" when it gets beforeinput.
selecting.addEventListener("beforeinput", (event) => {
  const text = selecting.firstChild;
  if (!event.isTrusted) getSelection().setBaseAndExtent(text, 1, text, 3);
});
// A field that takes what is typed into it and clears itself, as a hidden editor input does.
window.consumed = [];
const consumer = document.getElementById("consumer");
consumer.addEventListener("input", () => {
  window.consumed.push(consumer.value);
  consumer.value = "";
});
</script>
</body></html>
`;
}

// A form for fill_form, sent to the other site, with a field of each kind it fills and fields
// whose page refuses, undoes or delays the fill. Every input, change and blur event is logged.
function fillFormPage(port: number): string {
  const other = `http://localhost:${port}/a`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.fillForm}</title></head>
<body>
<form id="form" action="${other}" method="get">
<input id="text" name="text" aria-label="Text" value="Old text">
<input id="second-text" name="second-text" aria-label="Second text" value="Old second">
<textarea id="area" name="area" aria-label="Area">Old line</textarea>
<input id="email" name="email" type="email" aria-label="Email" value="old@example.com">
<input id="number" name="number" type="number" aria-label="Number" value="12">
<input id="password" name="password" type="password" aria-label="Password" value="${FILL_PASSWORD}">
<input id="react" aria-label="React" value="">
<input id="cancelling" aria-label="Cancelling" value="Before">
<input id="suggest" aria-label="Suggest" value="">
<input id="disabled" aria-label="Disabled" value="Off" disabled>
<select id="single" name="single" aria-label="Single">
<option value="">Choose one</option>
<option value="se">Sweden</option>
<option value="no" disabled>Norway</option>
<option value="fi">Finland</option>
</select>
<select id="sticky" aria-label="Sticky"><option value="a">Ay</option><option value="b">Bee</option></select>
<select id="multi" name="multi" aria-label="Multi" multiple>
<option value="r" selected>Red</option>
<option value="g">Green</option>
<option value="b">Blue</option>
</select>
<input id="off" type="checkbox" aria-label="Off box">
<input id="on" type="checkbox" aria-label="On box" checked>
<input id="first" type="radio" name="pick" aria-label="First pick" checked>
<input id="second" type="radio" name="pick" aria-label="Second pick">
<input id="stubborn" type="checkbox" aria-label="Stubborn box">
<a id="link" href="${other}">Away <input id="linked" type="checkbox" aria-label="Linked box"></a>
<select id="security" aria-label="Security"><option value="none">None</option><option value="wpa2">WPA2</option></select>
<input id="show-key" type="checkbox" aria-label="Show key">
<input id="short" aria-label="Short" maxlength="4" value="Ab">
<input id="guarded" aria-label="Guarded" value="Guarded before">
<input id="locking" aria-label="Locking" value="Locking before">
<input id="shifty" aria-label="Shifty" value="Shifty before">
<input id="late-cancelling" aria-label="Late cancelling" value="Late before">
<input id="slow" aria-label="Slow" value="Slow before">
<input id="slower" aria-label="Slower" value="Slower before">
<button type="submit">Send</button>
</form>
<script>
window.submits = 0;
document.addEventListener("submit", () => { window.submits += 1; }, true);
window.events = [];
for (const type of ["input", "change", "blur"]) {
  document.addEventListener(type, (event) => {
    window.events.push({ id: event.target.id, type, trusted: event.isTrusted });
  }, true);
}
window.countOf = (id, type) => window.events.filter((event) => event.id === id && event.type === type).length;
// React's value tracking, as on the input page.
window.reactState = {};
function controlled(input, accepts) {
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  let tracked = native.get.call(input);
  let state = tracked;
  window.reactState[input.id] = state;
  Object.defineProperty(input, "value", {
    configurable: true,
    get() { return native.get.call(this); },
    set(value) { tracked = String(value); native.set.call(this, value); },
  });
  input.addEventListener("input", () => {
    const now = native.get.call(input);
    if (now !== tracked) {
      tracked = now;
      if (accepts) state = now;
      window.reactState[input.id] = state;
    }
    input.value = state;
  });
}
controlled(document.getElementById("react"), true);
// A field that takes no browser insertion, as an editor that handles beforeinput itself.
document.getElementById("cancelling").addEventListener("beforeinput", (event) => event.preventDefault());
// A box that clears unmatched text when it loses focus, as a suggesting combobox does.
const suggest = document.getElementById("suggest");
suggest.addEventListener("blur", () => { suggest.value = ""; });
// A select whose page sets its previous option back.
const sticky = document.getElementById("sticky");
sticky.addEventListener("change", () => { sticky.value = "a"; });
document.getElementById("stubborn").addEventListener("click", (event) => event.preventDefault());
// A select that adds a password field and a checkbox that shows it as text, as a router's page does.
const security = document.getElementById("security");
security.addEventListener("change", () => {
  if (document.getElementById("key") !== null) return;
  const key = document.createElement("input");
  key.id = "key";
  key.type = "password";
  key.setAttribute("aria-label", "Key");
  key.value = "${FILL_KEY}";
  security.after(key);
});
document.getElementById("show-key").addEventListener("change", (event) => {
  const key = document.getElementById("key");
  if (key !== null) key.type = event.target.checked ? "text" : "password";
});
// Fields whose page makes them read-only, or no text field, as they take text or focus.
const guarded = document.getElementById("guarded");
guarded.addEventListener("beforeinput", (event) => {
  guarded.readOnly = true;
  event.preventDefault();
});
const locking = document.getElementById("locking");
locking.addEventListener("focus", () => { locking.readOnly = true; });
const shifty = document.getElementById("shifty");
shifty.addEventListener("focus", () => { shifty.type = "checkbox"; });
function busy(id, type, ms) {
  document.getElementById(id).addEventListener(type, (event) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {}
    if (type === "beforeinput") event.preventDefault();
  });
}
busy("slow", "focus", ${FILL_SLOW_MS.slow});
busy("slower", "focus", ${FILL_SLOW_MS.slower});
// Takes no browser insertion, and decides that only after the text bound has passed.
busy("late-cancelling", "beforeinput", ${FILL_SLOW_MS.slower});
</script>
</body></html>
`;
}

// Editor input frames on the page's own site, as Google Docs has: one with an editable body and
// one in designMode, whose scripts take what is inserted and clear it; and a sandboxed frame.
const INPUT_FRAMES_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.inputFrames}</title></head>
<body>
<iframe id="docs" class="docs-texteventtarget-iframe" title="Docs input"></iframe>
<iframe id="design" class="docs-texteventtarget-iframe" title="Design input"></iframe>
<iframe id="sandboxed" sandbox title="Sandboxed" srcdoc="<body contenteditable='true'>x</body>"></iframe>
<script>
window.received = [];
const docs = document.getElementById("docs").contentDocument;
docs.open();
docs.write('<!doctype html><body contenteditable="true"></body>');
docs.close();
const design = document.getElementById("design").contentDocument;
design.designMode = "on";
for (const frame of [docs, design]) {
  frame.addEventListener("input", () => {
    window.received.push(frame.body.textContent);
    frame.body.textContent = "";
  });
}
</script>
</body></html>
`;

/**
 * Forms for press_key Enter. Every form but the navigating one is kept from submitting by its
 * submit listener, which records the form and its submitter. Key events are recorded at the
 * document.
 */
function inputFormsPage(port: number): string {
  const other = `http://localhost:${port}/a`;
  const image = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.inputForms}</title></head>
<body>
<form id="with-button" class="stay" action="/a"><input aria-label="Name" name="name"><input aria-label="Second" name="second"><button id="send" type="submit">Send</button></form>
<form id="one-field" class="stay" action="/a"><input aria-label="Only" name="only"><input type="checkbox" aria-label="Remember" name="remember"></form>
<form id="two-fields" class="stay" action="/a"><input aria-label="First of two" name="a"><input aria-label="Second of two" name="b"></form>
<form id="disabled-field" class="stay" action="/a"><input aria-label="Disabled field" name="d" disabled></form>
<form id="prevented" class="stay" action="/a"><input id="prevented-field" aria-label="Prevented" name="p"></form>
<form id="required" class="stay" action="/a"><input aria-label="Required" name="r" required><button id="required-send" type="submit">Go</button></form>
<form id="image-only" class="stay" action="/a"><input aria-label="Image first" name="a"><input aria-label="Image second" name="b"><input id="image-send" type="image" alt="Image send" src="${image}"></form>
<form id="shadowed" class="stay" action="/a"><input aria-label="Shadowed" name="requestSubmit"><input type="hidden" name="noValidate" value="1"><input type="hidden" name="baseURI" value="2"><input type="hidden" name="elements" value="3"><input type="hidden" name="getRootNode" value="4"><button id="shadowed-send" type="submit">Shadowed send</button></form>
<form id="away" action="${other}"><input id="away-field" aria-label="Away" name="q"></form>
<form id="away-named" action="${other}"><input id="away-named-field" aria-label="Away named" name="action"></form>
<form id="mail" method="post" enctype="text/plain" action="mailto:someone@example.org"><input id="mail-field" aria-label="Mail" name="body"></form>
<form id="shadowed-alone" class="stay" action="/a"><input aria-label="Shadowed alone" name="requestSubmit"></form>
<form id="away-button" class="stay" action="/a"><input id="away-button-field" aria-label="Away by button" name="q"><button id="away-send" type="submit" formaction="${other}">Away send</button></form>
<form id="rewritten" action="/a"><input id="rewritten-field" aria-label="Rewritten" name="q"></form>
<form id="navigating" action="/b"><input aria-label="Navigating" name="q"></form>
<button id="plain-button" type="button">Plain button</button>
<a id="away-link" href="${other}">Away link</a>
<a id="mail-link" href="mailto:someone@example.org">Mail link</a>
<svg width="120" height="30"><a id="svg-link" href="/a" tabindex="0"><rect width="120" height="30" fill="#ccc"></rect></a></svg>
<div id="shadow-host"></div>
<form id="away-plain" action="${other}"><input id="away-plain-field" aria-label="Away plain" name="q"><button id="away-plain-send">Away plain send</button></form>
<script>
window.submits = [];
window.keys = [];
window.clicks = [];
function recordSubmit(event) {
  window.submits.push(event.target.id + ":" + (event.submitter ? event.submitter.id : ""));
  if (event.target.classList.contains("stay")) event.preventDefault();
}
const shadow = document.getElementById("shadow-host").attachShadow({ mode: "open" });
shadow.innerHTML = '<form id="shadow-form" class="stay" action="/a"><input aria-label="Shadow name" name="n"></form>';
for (const form of [...document.querySelectorAll("form"), shadow.getElementById("shadow-form")]) {
  form.addEventListener("submit", recordSubmit);
}
for (const type of ["keydown", "keypress", "keyup"]) {
  document.addEventListener(type, (event) => {
    window.keys.push(type + ":" + event.target.id + ":" + event.key);
  }, true);
}
document.addEventListener("click", (event) => { window.clicks.push(event.target.id); }, true);
document.getElementById("prevented-field").addEventListener("keydown", (event) => event.preventDefault());
document.getElementById("rewritten-field").addEventListener("keydown", () => {
  document.getElementById("rewritten").action = ${JSON.stringify(other)};
});
</script>
</body></html>
`;
}

// Tab order with positive, zero and negative tab indexes, a disabled button, a hidden input and a
// radio group; a focusable container; open, closed and slotting shadow roots; an editing host;
// a popover, a modal dialog, a select and a page key listener.
const INPUT_KEYS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.inputKeys}</title></head>
<body>
<button id="zero-a">Zero A</button>
<input id="two" tabindex="2" aria-label="Two">
<button id="negative" tabindex="-1">Negative</button>
<input id="one" tabindex="1" aria-label="One">
<button id="disabled" disabled>Disabled</button>
<input id="hidden" type="hidden" value="h">
<input type="radio" name="colour" id="red" aria-label="Red">
<input type="radio" name="colour" id="green" aria-label="Green" checked>
<input type="radio" name="colour" id="blue" aria-label="Blue">
<button id="zero-b">Zero B</button>
<main id="container" tabindex="-1"><button id="inner">Inner</button></main>
<div id="open-host"></div>
<div id="closed-host"></div>
<div id="slot-host"><button id="slot-light">Light</button></div>
<div id="editable" contenteditable="true">Edit</div>
<select id="fruit" aria-label="Fruit"><option>Apple</option><option disabled>Banana</option><optgroup label="More" disabled><option>Cherry</option></optgroup><option>Date</option></select>
<div id="pop" popover>Popover</div>
<dialog id="dialog"><button id="in-dialog">In dialog</button></dialog>
<dialog id="fixed-dialog" closedby="none"><button id="in-fixed-dialog">In fixed dialog</button></dialog>
<script>
window.keys = [];
window.changes = [];
for (const type of ["keydown", "keyup"]) {
  document.addEventListener(type, (event) => {
    window.keys.push(type + ":" + event.target.id + ":" + event.key + (event.ctrlKey ? ":ctrl" : ""));
  }, true);
}
document.getElementById("fruit").addEventListener("input", (event) => window.changes.push("input:" + event.target.value));
document.getElementById("fruit").addEventListener("change", (event) => window.changes.push("change:" + event.target.value));
window.openRoot = document.getElementById("open-host").attachShadow({ mode: "open" });
window.openRoot.innerHTML = '<button id="open-inner">Open inner</button>';
window.closedRoot = document.getElementById("closed-host").attachShadow({ mode: "closed" });
window.closedRoot.innerHTML = '<button id="closed-inner">Closed inner</button>';
window.slotRoot = document.getElementById("slot-host").attachShadow({ mode: "open" });
window.slotRoot.innerHTML = '<button id="slot-a">A</button><slot></slot><button id="slot-b">B</button>';
/** The id of the focused element, followed into the shadow roots of this page. */
window.focusedId = () => {
  let focused = document.activeElement;
  for (const root of [window.openRoot, window.closedRoot, window.slotRoot]) {
    if (root.host === focused && root.activeElement !== null) focused = root.activeElement;
  }
  return focused === null ? null : focused.id || focused.localName;
};
</script>
</body></html>
`;

// The root does not scroll and body does: the viewport takes the root's overflow, not body's.
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

// A list that reorders by HTML drag and drop as SortableJS does in Firefox: pressing an item makes
// it draggable, dragstart starts the drag only in a later task, which also shrinks the dragged
// item as a ghost class can, a drop or dragend before then cancels it, and once started a dragover
// whose point lies on another item moves the dragged item into that item's place. window.order()
// gives the items' order, window.log what the drag did.
const ACT_SORTABLE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.actSortable}</title>
<style>
body { margin: 0; font: 14px sans-serif; }
#list { width: 200px; margin: 10px; }
#list > div { height: 30px; border: 1px solid #ccc; }
#list > .ghost { height: 6px; overflow: hidden; }
</style></head>
<body>
<div id="list" role="list">
<div role="listitem" aria-label="Item 1">Item 1</div>
<div role="listitem" aria-label="Item 2">Item 2</div>
<div role="listitem" aria-label="Item 3">Item 3</div>
<div role="listitem" aria-label="Item 4">Item 4</div>
<div role="listitem" aria-label="Item 5">Item 5</div>
<div role="listitem" aria-label="Item 6">Item 6</div>
</div>
<script>
const list = document.getElementById("list");
window.log = [];
window.order = () => Array.from(list.children, (item) => item.textContent);
let dragged = null;
let started = false;
let pending = 0;
list.addEventListener("pointerdown", (event) => {
  dragged = event.target.closest('[role="listitem"]');
  if (dragged !== null) dragged.draggable = true;
});
list.addEventListener("dragstart", () => {
  pending = setTimeout(() => {
    started = true;
    dragged.classList.add("ghost");
    window.log.push("started");
  }, 0);
});
list.addEventListener("dragenter", (event) => event.preventDefault());
list.addEventListener("dragover", (event) => {
  event.preventDefault();
  const over = event.target.closest('[role="listitem"]');
  if (!started || over === null || over === dragged) return;
  const box = over.getBoundingClientRect();
  if (event.clientY < box.top || event.clientY > box.bottom) return;
  const items = Array.from(list.children);
  if (items.indexOf(dragged) < items.indexOf(over)) over.after(dragged);
  else over.before(dragged);
});
document.addEventListener("drop", (event) => {
  event.preventDefault();
  end("dropped");
});
document.addEventListener("dragend", () => end("ended"));
function end(how) {
  if (dragged === null) return;
  clearTimeout(pending);
  dragged.draggable = false;
  dragged.classList.remove("ghost");
  window.log.push(started ? how : "cancelled");
  dragged = null;
  started = false;
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

// Its fetches run when a test evaluates them. The frame is on the other site (the same server
// under localhost).
function networkBodiesPage(port: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.networkBodies}</title></head>
<body><h1>${TITLES.networkBodies}</h1>
<iframe title="Other site" src="http://localhost:${port}/network-bodies-frame"></iframe>
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

// On load: a fetch POST with a JSON body, then one that sends JSON as a urlencoded form, as
// jQuery's $.post and axios do with a string; the title says when both finished.
const NETWORK_JSON_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.networkJson}</title></head>
<body><h1>${TITLES.networkJson}</h1>
<script>
window.addEventListener("load", async () => {
  await fetch("/api/json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user: { name: "${NETWORK_SECRETS.jsonName}", nickname: "", age: 41, admin: false, manager: null },
      items: ["${NETWORK_SECRETS.jsonElement}"],
      "g-recaptcha-response": "${NETWORK_SECRETS.jsonToken}",
      "${NETWORK_SECRETS.jsonKey}": true,
    }),
  });
  await fetch("/api/form-json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: JSON.stringify({ password: "${NETWORK_SECRETS.formJson}" }),
  });
  document.title = "${TITLES.networkJsonDone}";
});
</script>
</body></html>
`;

// Firefox's default for webextensions.webRequest.requestBodyMaxRawBytes.
const FIREFOX_RAW_BODY_LIMIT = 16_777_216;

// On load: a fetch POST of a JSON body exactly as long as Firefox's limit for request bodies, then
// one a byte longer; the title says when both finished.
const NETWORK_LARGE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.networkLarge}</title></head>
<body><h1>${TITLES.networkLarge}</h1>
<script>
const sized = (bytes) => '{"a":"' + "x".repeat(bytes - 8) + '"}';
window.addEventListener("load", async () => {
  for (const [path, bytes] of [
    ["/api/json-at-limit", ${FIREFOX_RAW_BODY_LIMIT}],
    ["/api/json-over-limit", ${FIREFOX_RAW_BODY_LIMIT + 1}],
  ]) {
    await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: sized(bytes),
    });
  }
  document.title = "${TITLES.networkLargeDone}";
});
</script>
</body></html>
`;

const NETWORK_LOGIN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLES.networkLogin}</title></head>
<body><h1>${TITLES.networkLogin}</h1>
<form method="post" action="/network-login-post">
<label>User name <input type="text" name="username" value="${NETWORK_SECRETS.loginUser}"></label>
<label>Password <input type="password" name="password" value="${NETWORK_SECRETS.loginPassword}"></label>
<button type="submit">Sign in</button>
</form>
</body></html>
`;

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
