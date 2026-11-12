# 0009: Foxleash's content script is injected per tab and per request, never registered by URL

**Status:** Accepted, 2026-10-19.

## Context

The page tools (reading a page, typing, clicking) need code in the page: a content script in
Firefox's isolated world that can see the DOM and hand out references to its elements. The
add-on listing (`docs/amo/listing.md`) says Foxleash's scripts run in the pages of the agent's
tabs, and Mozilla reviews the extension against that sentence. The manifest already has the
`scripting` permission and `<all_urls>`, so any of Firefox's ways to run a content script is
available without a permission change.

Both `scripting.registerContentScripts` and the manifest's `content_scripts` key select pages
by URL pattern. They would run the script in the user's own tabs too, on every site, which
contradicts the listing and gives every page the user visits a listener to talk to.

The page's content is also the main threat (ADR 0002): a page can try to reach the content
script, forge its answers, guess element references, or print text that looks like the end
of the untrusted part of a tool result.

## Decision

- **Injection.** `apps/extension/src/page-scripts.ts` injects `content.js` with
  `scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"],
  injectImmediately: true })`, per tab and per request, in the isolated world.
  `injectImmediately` is safe because the script only adds a message listener, and without it
  Firefox waits until the page has finished loading. The script starts once per document: a
  flag on its own global, set after the listener, makes later injections do nothing.
- **The gate, three times.** Before the injection, `allowedPageSite` (`handlers.ts`, the same
  check `probe_input` runs) refuses a tab that is missing, outside the session's group,
  showing the session's open prompt, not on an http(s) page, on a blocklisted site or on a
  site the session may not act on. It runs again after the injection, right before the
  message is sent, and once more after the reply, so access withdrawn meanwhile (the site
  forgotten, revoked or blocklisted, the tab moved out of the group) refuses the request and
  nothing from the page reaches the agent; a different site is `page_changed`.
- **Messaging.** Only the background starts a conversation: `tabs.sendMessage` to frame 0 and
  the reply. The content script never calls `runtime.sendMessage` or `runtime.connect`, and
  never reads or writes `storage` (ADR 0007). The existing listeners already refuse content
  scripts as senders: the prompt port needs the prompt page's URL and tab, and settings
  messages the settings page's URL. Both waits are bounded: 20 s for the injection and 10 s
  for the reply, together below the host's 60 s request timeout, which shuts the host down.
- **Site checks on both sides.** Every request carries the site the background checked. The
  content script compares it with its own document's site before any handler runs, and the
  background compares the reply's site with it again.
- **The reply is untrusted input.** It comes from the page's content process, so the
  background reads own fields only, passes through only an allow-list of error codes
  (`PAGE_ERROR_CODES`), cuts their messages to 500 characters and refuses a reply longer than
  2,000,000 characters as JSON. It stops writing that JSON as soon as it is sure to pass the
  cap, counting each value JSON leaves out as one character, since a structured clone carries
  a shared object once and a small reply can stand for gigabytes of JSON or billions of values
  to walk. `capText` cuts page text for the page tools without splitting
  a surrogate pair; read_page will use it at about 50,000 characters.
- **Element references** are `<docId>-<n>`: `docId` is 8 random hex characters made when the
  script starts in a document, `n` counts from 1 and is never reused. The registry holds
  elements weakly, in the content script's memory only, and resolves a ref only while its
  element is in that document.
- **Top frame only**, until per-frame approval exists (ADR 0007 approves sites, and an
  embedded frame can be on another site).
- **The untrusted frame.** The MCP server (`apps/server/src/tools.ts`, ADR 0005) puts every
  result and host error between a start line and an end line that carry the same random
  64-bit id, drawn after the text exists and drawn again while the text contains it.
- **Later document_start needs** (reading the console from the start of a load) use
  `executeScript` with `injectImmediately` from `webNavigation.onCommitted` for tabs in a
  session's group, not `registerContentScripts`.

## Alternatives rejected

- **`registerContentScripts` or manifest `content_scripts`.** They match URLs, not tabs: the
  script would run in the user's own tabs and the listing would be false.
- **Refs in DOM attributes** (`data-foxleash-ref`). The page can read and forge them, and
  writing them changes the page the agent is reading.
- **A bare counter as the ref.** The script's state dies with its document, so after a
  navigation a new counter would hand an old ref such as `5` to a different element. The
  docId makes such a ref `stale_ref` instead.
- **A fixed end marker** for the untrusted part. A page can print it; a random id drawn after
  the text exists cannot be predicted by it.
- **Injecting into every frame.** Frames on other sites would need their own approval, which
  is not designed yet.
- **`crypto.randomUUID()` for the docId.** It exists only in secure contexts, so it can be
  missing on plain http pages.

## Consequences

- Every request pays for an injection; the start-once flag keeps the document's listener and
  refs.
- `executeScript` targets a tab and a frame, not a document. A navigation between the gate and
  the injection can put the script into a document on another site, where it only refuses:
  its site check runs before any handler, and the background checks the reply's site.
- A timeout stops the background waiting, not a handler that is already running in the page.
- Same-document navigations (history.pushState, a hash change) keep the document and its
  refs; a page restored from the back-forward cache comes back with its refs, which is
  correct for that document.
- A request on a tab the session is not approved for is refused without asking; the agent
  asks the user by reloading the tab with navigate.
