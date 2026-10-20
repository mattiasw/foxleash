# 0015: read_console records in the page's main world from the top-frame commit, through the page tools' gate

**Status:** Accepted, 2026-10-20.

## Context

`read_console` returns what a page in the agent's tab group wrote to its console, its
uncaught errors and its unhandled promise rejections. Those happen in the page's own world
from the start of its load, so a recorder has to be in the page before the page's scripts
run, and it has to wrap `console` as the page sees it, which Foxhand's isolated content script
(ADR 0009) cannot do.

The add-on listing says page content, console messages included, "comes only from what a tab
showed or loaded while its page was on a site you approved". A tab keeps its group across
navigations, and access to a site can be withdrawn and given again without a navigation (the
user forgets the site for the session and approves it again, drags the tab out of the group
and back, or blocklists and unblocks it). Records from such a gap must never reach the agent.

## Decision

- **Start at the commit.** `apps/extension/src/console-recording.ts` listens to
  `webNavigation.onCommitted` (registered at the top level of the background script). For the
  top frame only, it finds the session that owns the tab's group (`SessionGroups.sessionOf`)
  and runs the page tools' gate on the committed URL, not the tab's, which can still be the
  previous page's: `allowedSiteFor` in `handlers.ts`, the same check `allowedPageSite` ends
  with (not the session's open prompt, an http(s) page, not blocklisted, approved). Only then
  does it inject `recordConsole` (`console-recorder.ts`) with
  `scripting.executeScript({ target: { tabId, frameIds: [0] }, func, args, world: "MAIN",
  injectImmediately: true })`. Nothing is registered by URL (ADR 0009).
- **The recorder** is a self-contained function shipped in the package; the site and its
  limits come in as arguments, nothing is evaluated as code (ADR 0004). It does nothing unless
  the document is on the gated site, starts once per document, captures every built-in it
  calls later, wraps `console.debug/log/info/warn/error` so the page's call always reaches the
  original with the same `this` and arguments, listens for `error` and `unhandledrejection`,
  formats arguments as text (strings as they are, errors as name and message, binary data as
  its type, other objects as JSON within a work budget of ten times the text limit), ignores
  console calls made while it formats a value, and clears its records when the document comes
  back from the back-forward cache.
- **Records live in the document.** A new document starts empty, so a navigation drops
  everything. The recorder keeps the newest 300 messages, each cut to 1,000 UTF-16 units
  (`MAX_CONSOLE_MESSAGES`, `MAX_CONSOLE_TEXT`), and counts the dropped ones. With 300 x 1,000
  characters that each escape to six as JSON, the reply stays under the background's
  2,000,000-character cap on page replies.
- **Reading.** `read_console` goes through `pages.request` (ADR 0009: gated before the
  injection, before the message and after the reply). The content script dispatches a
  `foxhand-console-read` event on the window and takes the first `foxhand-console-records`
  reply, dispatched synchronously by the recorder, whose `detail` is a JSON string: a string
  crosses into the content script's world as it is, an object would not. The content script,
  the background and the MCP server each check the shape again, the background and the server
  with the count and length limits.
- **Live recordings.** The background keeps, per tab, the recording started at its latest
  top-frame commit (session, site, group). It is dropped at the tab's next top-frame commit, at
  once; when the tab moves to another group or window or closes, or is found in another group
  just after the recording starts (a move while the gate ran); when the tab's URL moves to
  another site without a commit (a page restored from the back-forward cache); when the user
  forgets the session's approval of the site or the session ends (`onWithdraw` in
  `site-access.ts`); and after any `storage.local` change once the gate refuses its site (a
  stored approval revoked, the site blocklisted). A read returns `recording: false` with no
  messages unless the same live recording exists before and after the page request.
- **Filtering in the MCP server.** `apps/server/src/tools.ts` compiles `pattern` with
  `new RegExp` before asking Firefox, then filters by minimum level and pattern (under a time
  limit) and keeps the newest `limit` matches (100 unless given), reporting how many it left
  out.

## Alternatives rejected

- **`scripting.registerContentScripts` with `world: "MAIN"`.** It matches URLs, not tabs, so
  it would run in the user's own tabs.
- **A buffer in the isolated content script, fed per record.** Records before that script
  starts would be lost, and it would have to run from the commit in every recorded document.
- **Firefox's `wrappedJSObject` and `exportFunction`.** They hand the page a function from the
  extension's world.
- **A buffer in the background.** The content script would have to call
  `runtime.sendMessage`, which ADR 0009 rules out.
- **Filtering in the page or the background.** A slow regular expression would freeze the
  user's tab or every session.
- **Accepting records from a gap in access and rewording the listing.** It would weaken a
  published claim.
- **Injecting a stop into each affected page when access is withdrawn.** One injection per tab
  per withdrawal, and a failed injection would leave the gap readable.

## Consequences

- Messages a page logs before the injection lands are missed.
- After any interruption of access, or for a page that loaded before the user approved its
  site, `read_console` says it is not recording until the page is loaded again.
- The page can see, forge, clear or block its own records and the read events, and can tell
  that its console is wrapped and when Foxhand reads it. It can reach nothing beyond its own
  document's bounded reply, which every later step treats as untrusted.
- Formatting runs a logged object's getters and `toJSON` when it is logged; DevTools runs
  them only when it shows the object. Stringifying a plain object costs work in proportion to
  its own key count. DevTools may show the recorder as the source of console calls in recorded
  documents (not checked in Firefox).
- The page writes the text a pattern runs against, so it can make a backtracking pattern slow.
  Matching runs in a `node:vm` context with a one-second timeout, and a read that hits it
  returns an error instead of stalling the agent's own `foxhand mcp` process.
