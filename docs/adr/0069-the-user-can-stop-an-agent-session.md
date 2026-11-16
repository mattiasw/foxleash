# 0069: The user can stop an agent session from the settings page

**Status:** Accepted, 2026-11-16.

## Context

A user who is nearby while an agent works had no single control in Firefox that stops it. Site
access kept only per-session answers, and a site stored as allowed always passes the gate for every
session (`view().allowed()` in `apps/extension/src/site-access.ts`). The settings page could only
forget one session answer at a time, and the toolbar button only opens the settings. Closing the
session's tab group takes no access away: the next `tab_open` makes a new group.

## Decision

- **The control.** The settings page lists each running agent session with a **Stop this
  session** button. The click sends `{ type: "stop", session }`, which `receiveFromSettings`
  accepts only behind the settings page's sender check, as it does `forget`. Nothing arriving over
  native messaging or from a content script can stop or restart a session. There is no
  confirmation dialog: stopping only narrows access, so one click stops.
- **Where the state lives.** `SiteAccess.stop` adds the session to a set of stopped sessions, and
  `view()` throws `session_stopped` for it after its only await, so a stop before or during the
  settings read is seen. Every gate goes through `view()` (`check`, `ask`, `siteStates`,
  `allowForSession`, `allowedSiteFor` and so page scripts and live documents, downloads, the act
  settle), so every site-gated step refuses, also on sites allowed always, with no per-tool check.
  `refuseIfStoppedAsking` refuses it too, so no recipe or site-request page opens.
- **On arrival and on completion.** `handleRequest` in `handlers.ts` calls `access.admit` on each
  request's arrival, which records the session as running and refuses a stopped one, so tools that
  never reach a site gate (`tab_close`, `tab_select`, `resize_window`, the recipe tools) are refused
  too. When a call ends after the stop, whether it succeeded or failed, `handleRequest` replaces its
  outcome with `session_stopped`, synchronously before the response goes back: nothing a call under
  way got reaches the agent. The page request loop in `page-scripts.ts` treats `session_stopped` as
  final and never retries it.
- **What the stop ends.** Synchronously, in this order: its session answers are forgotten; its open
  site prompt is dropped, its waiting request rejected with `session_stopped` and the prompt page
  told `ended`, without charging the closed-prompt budget; `onWithdraw` is told of each site it
  allowed for the session; then the `onStop` listeners run, which drop the session's live documents
  (console and network recordings) and page views whatever the site, end its recipe or site-request
  page through `recipes.endSession` (a propose page detaches, so the user can still save what they
  read; `propose` closes a page still opening at the stop, or ends it once it began loading, so such
  a page never shows its recipe), and set its tabs' toolbar badge off with the title "Foxleash: the
  agent session of this tab was stopped". A second stop of the same session does nothing.
- **The tab group** stays, with its tabs: the user's pages stay open.
- **Lifetime.** The stop is kept in the background page's memory, by session id, and `endSession`
  leaves it: a session that reconnects with the same id stays stopped. It is not stored.
- **The list.** `sessionAnswers` lists each running session (admitted and not ended), and any other
  session that holds answers, each with `stopped`. Running sessions are numbered in the order they
  first sent a request, so two sessions with the same tab count are told apart: "session 2 with 3
  tabs". A stopped session's row reads "Agent session 2 with 3 tabs, stopped", with no button and no
  answer rows.
- **Focus.** When the focused Stop button's row is gone after a refresh, focus moves to the section
  heading, never to another session's Stop button at the same place, where the next Enter would
  stop a session the user did not choose. After a click the row is rebuilt without a button, so
  focus goes to the heading and the live region announces the result.
- **The toolbar button** keeps opening the settings page.

## Alternatives rejected

- **Closing the tab group as the stop.** Users close groups routinely, and the next tab the agent
  opens makes a new group; an explicit button says what it does.
- **A toolbar popup with the button.** A popup replaces the button's click, which opens the
  settings, and changes the manifest.
- **Storing stops.** A new agent session gets the same access anyway (the sites allowed always), so
  keeping a stop across a background restart would add little and leave stale ids in storage.
- **A confirmation dialog.** Stopping only narrows access; an extra step slows the user who needs
  to stop an agent now.
- **A check in each tool.** Every gate already goes through `view()`; per-tool checks would leave
  the next tool unguarded by default.

## Consequences

- A call already under way at the click may still finish what it was doing (a click or typing
  already sent to the page, a page load, a file being saved, closing or selecting a tab, resizing
  the window), but it returns only the refusal.
- A `batch` under way returns what its earlier steps read before the click, with the refusal for
  the rest: the server keeps the results of the steps before a failed one, and the server is not
  changed.
- Anything that restarts the background page (a Firefox restart, an extension update or reload)
  forgets the stop, as it forgets session answers and the prompt budget; a session that reconnects
  afterwards has what a new session has. A new agent session, with a new id, is not stopped.
- The open prompt page says "This request has ended. Ask the agent to try again.", its text for any
  ended request.
- A session whose program went away without telling the extension stays listed as running until
  the background page restarts.
