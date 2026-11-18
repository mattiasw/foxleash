# 0091: The file guard remembers the tab groups it made for sessions, and judges their tabs after a restart, an update or a reload

**Status:** Accepted, 2026-11-18. Amends
[0081](0081-session-tabs-cancel-files-from-sites-the-session-may-not-act-on.md): its last
consequence.

## Context

The file guard of ADR 0081 judges a tab by the session of its group, and session groups lived only
in the background's memory: `groups` in `createSessionGroups`
(`apps/extension/src/session-groups.ts`) is filled when `addToGroup` creates a group and emptied
by `forget`. After a Firefox restart, or an update or reload of the add-on, that map is empty and
no session runs. So `sessionOfTab` in `apps/extension/src/file-guard.ts` judged a tab left in an
old session group as no session's, and `listen()`, run only from `access.onRunningChange`, did not
even add the blocking listener until the next session's first request. A page of the approved site
left open there that sent its tab, or a frame, to another site's file got the file saved, and
`upload_file` could hand it to that page. With the code before this change, a probe confirmed it:
after a reload and after a restart, the old group's tab sent to the other site's attachment got it
saved.

Remembering the groups only helps if Firefox keeps a group's id across those events, and storage
across them, so both were measured first.

## Measurements

In headless Firefox 160.0.1 and 153.7.0esr through the end-to-end harness, with the built
extension and a probe add-on that only logged. Restarts are the harness's
`restartFirefox(..., { restoreSession: true })`, which installs the add-on again as a temporary
add-on.

**The group id (H3).** A session tab's `groupId`, read with `browser.tabs.query({})` in the
settings page, was the same number before and after `browser.runtime.reload()`, and after each of
three restarts (on 160.0.1 the tab's id changed from 7 to 1, its `groupId` did not). A group the
user saves and closes and opens again, done with `group.saveAndClose()` and
`SessionStore.openSavedTabGroup(id, window)` in a privileged script, came back with the same
`groupId` and a new tab id (4 to 6 in the separate run, on both versions; `saveAndClose()` is
synchronous on 153 and returns a promise on 160). Firefox's internal group id was of the shape
`"1795019160877-40"`, and the number the extension API gives is that id's millisecond timestamp
times 1000 plus its suffix (`getExtTabGroupIdForInternalTabGroupId` in Firefox's `ext-browser.js`).
An internal id of another shape gets a small number counted from 1 per browser run instead, which
would not be stable; every group measured had the timestamp shape.

**Storage (H4).** A `storage.local` key survived `runtime.reload()` and the harness restart with no
pref set, on both versions; it also survived with `extensions.webextensions.keepStorageOnUninstall`
set, and with that and `extensions.webextensions.keepUuidOnUninstall`, so neither pref is needed.

**Idle suspension (H11, runs 1 and 2).** A session ended with its group's tab left on the approved
site's page; Firefox's background state (`WebExtensionPolicy.getByID(id).extension.backgroundState`)
was read every 9 seconds. With the native port connected (run 1), and with the native host killed
and its manifest removed so that every reconnect, at most every 10 seconds, failed (run 2), the
background was `running` throughout 63 seconds on both versions; the page's own 60-second timer
then loaded the other site's attachment, and nothing was saved. Firefox's `ext-backgroundPage.js`
exempts a background with an open native messaging port from the idle timeout; in run 2 it stayed
running all the same.

**A listener added during a request (H13).** A blocking `onHeadersReceived` listener added 1,002
to 1,006 ms into a request whose answer came at about 3,000 ms saw that response at 3,002 to 3,003
ms and cancelled it, nothing saved, in 4 of 4 runs on each version; 2 control runs per version with
the listener added before the request gave the same.

**The listener's cost (H11, run 3).** In one Firefox, each step waited 45 seconds with no session
running, then made 20 loads, one after another, of a small HTML page of the approved site in a tab
outside every group, each timed by the page's Navigation Timing `duration`. The background was
`running` before and after every wait. Medians in ms, minimum to maximum in brackets:

| Step, in order | 160.0.1 | 153.7.0esr |
|---|---|---|
| 1. no listener, before any session | 12 (8 to 19) | 12 (9 to 17) |
| 2. the guard's listener, after a session ran and ended | 34 (30 to 36) | 27 (25 to 33) |
| 3. no listener, after `runtime.reload()` | 27.5 (25 to 39) | 27 (25 to 35) |
| 4. as 3, plus another add-on's blocking listener that answers at once, with the guard's filter | 32 (28 to 45) | 29 (26 to 42) |

Against the step right after it, without it, the guard's listener added 6.5 ms on 160.0.1 and none
on 153.7.0esr; a bare blocking listener added 4.5 and 2 ms. Every step after the first was about
15 ms slower whatever listener was there, also once the reload had removed the guard's; that began
after the probe add-on was installed, and its cause was not looked for. A second full run on
160.0.1 repeated the results above.

**Firefox's record of the listener.** With this change built, a privileged script read
`ExtensionParent.GlobalManager.getExtension(id).persistentListeners` and the add-on's
`startupData.persistentListeners`, the listeners Firefox records for the background's next start:

| State | 160.0.1 | 153.7.0esr |
|---|---|---|
| A fresh start | not recorded | not recorded |
| After a session ran and ended (the listener added at its first request) | not recorded | not recorded |
| After `runtime.reload()` with the old group's tab open (added at the background's start) | not recorded | not recorded |
| After a restart, the tab restored (added at the background's start) | recorded | not recorded |
| After a second restart | not recorded | not recorded |

Recorded means both held the guard's blocking `webRequest.onHeadersReceived` listener (`types:
["main_frame", "sub_frame"]`, `urls: ["<all_urls>"]`, `["blocking", "responseHeaders"]`) and its
`webNavigation.onCreatedNavigationTarget` listener. The harness installs the add-on again after
Firefox has started, so it cannot show what Firefox does with a record at its own start. Read in
Firefox 160's source: `ExtensionCommon.sys.mjs` records a listener added while the background
context's `listenerPromises` is set, which `ext-backgroundPage.js` clears once the listeners added
during the script's start have been handled. At the background's next start Firefox primes the
recorded listeners of the modules `ext-toolkit.json` marks `startupBlocking`, which `webRequest` is
and `webNavigation` is not, so the requests a primed `webRequest` listener matches wait until the
background has started. A listener added again during that start gets them; for one that is not,
`clearPrimedListeners` rejects them, `WebRequest.sys.mjs` lets a request go on past a listener
whose answer rejects, and the record is dropped.

## Decision

**What is remembered.** `addToGroup` in `session-groups.ts` keeps every group it creates in this
background life in memory for good (`createdGroups`, id to session), and stores the list under
`SESSION_GROUPS_KEY` (`"sessionGroups"`, in `settings.ts`) in `storage.local`, as `{ id, session }`
entries, oldest first. Each append, one after another on one chain, reads the stored list, keeps
its entries whose id this life did not create, adds every group of this life after them (for an id
in both, this life's session wins) and writes the result. `ensureGroup` resolves once the append
is done. A group a tab joins is not appended again, and `forget` removes nothing from memory or
storage: a group the user saved and closed can come back with its id.

**Failures.** A read that fails skips the write, so a failed read never shortens the stored list;
a write that fails is warned. Neither fails `ensureGroup`: the group is in memory, and the next
append writes it. A stored value that is not an array whose every element is a record with an own
`id` that is a safe integer and an own `session` that is a string is warned about and counts as
empty, and the next append replaces it.

**The cap.** At most 200 entries (`MAX_REMEMBERED_GROUPS`). Over that, one `tabs.query({})` gives
the groups that still have a tab, and the oldest entries without one are dropped until 200 remain.
A group that still has a tab is never dropped, so the list holds more than 200 when more groups
than that have a tab. When the query fails, every entry is kept and the failure is warned.

**The lookup.** `rememberedSessionOf(groupId)` answers the session a group was created for: one
this life created (current or forgotten), else one in the stored list. It answers undefined for
undefined and -1 without reading storage, reads the stored list at the first call that needs it
and keeps it, and when that read fails it warns, answers from memory alone, and reads again at the
next call. It never rejects. `sessionOf`, `isSessionGroup` and `groupOf`, which decide what the
agent reaches, are unchanged: a remembered group is never put back into `groups`.

**How the guard judges a tab.** `sessionOfTab` asks, in order: the session of the tab's current
group (`sessionOf`); the tab's tie (ADR 0089), or its opener's judgement now; and last,
`rememberedSessionOf(tab.groupId)`. A remembered session is judged by `access.view(session)` as
any other, which for a session that is gone holds only the sites allowed always. A window opened
from a remembered group's tab is tied to that session, with that tab as opener.

**When the guard listens.** `listen()` still runs at the first `access.onRunningChange`, and now
also as soon as a tab of a remembered group is seen: `createFileGuard` adds `tabs.onCreated` and
`tabs.onUpdated` listeners, which call `listen()` for a tab whose group `rememberedSessionOf`
answers, and once does the same for every tab of one `tabs.query({})`. A failed query is warned
about and left to those events. The blocking `webRequest` listener and the
`onCreatedNavigationTarget` listener are still added only in `listen()`, never at the top level of
the script, and never removed. The background already has top-level listeners on both tab events,
so the two new ones wake it for nothing new.

## Alternatives rejected

- **The blocking listener added at the top level of the background.** ADR 0081 rejected its
  wake-up cost. The harness installs the add-on after Firefox has started, so it cannot show how
  Firefox holds requests at its own start, and an update or reload would still leave a window
  before the listener exists. A measurement of a restored tab's load winning that race would
  reopen this.
- **Adding the listener only once the background's start is over, so Firefox never records it.**
  That avoids the hold at a start of the background, which at Firefox's start begins anyway, by
  lengthening the time after every start, update or reload in which nothing is judged.
- **`sessions.setTabValue` on each tab of the group.** It needs the `sessions` permission, a
  manifest and listing change, and a tab moved into the group later would carry nothing.
- **Recognising a group by its title and colour.** The user can make an orange group named
  Foxleash; the id is exact, and stable across the measured events (H3).
- **Putting remembered groups back into the session's groups, so the agent reaches them again.**
  That widens the agent's reach to tabs of a session that ended; ADR 0027 keeps it to the current
  group.
- **`storage.session`.** Firefox clears it when it restarts.

## Consequences

- From Firefox's start, or an update or reload of the add-on, until the background has read its
  list and added the listener, nothing is judged. The end-to-end test waits for the settings page
  before it sends the tab, and the export it loads answers 3 seconds later; a listener added within
  those 3 seconds still cancels it (H13).
- Whether Firefox records the guard's listeners for the background's next start is a race between
  the end of the background's start and the guard adding them, which at the start waits for a
  remembered group's tab to be seen, through the `tabs.query` or a tab event, and for the storage
  read, or comes with a session's first request. They were recorded once in the measurements, on
  160.0.1 after a restart. When they are, at the background's next start (Firefox's next start, or
  an update or reload if Firefox keeps the record across it, which was not looked at) page and
  frame loads in every tab wait until Foxleash's background has started, which at Firefox's start
  it does anyway, through its `runtime.onStartup` listener. How long they wait, and whether the
  first loads of restored tabs come before Firefox has primed the listener, was not measured. If
  the guard adds its listener again during that start, it judges the held loads in a remembered
  group's tabs, which narrows the window above for them; a window opened from such a tab before
  then gets no tie, since Firefox does not prime `onCreatedNavigationTarget` at a start, and is
  not judged. If not, Firefox lets the held loads go on unjudged and drops the record. This is the
  hold ADR 0081 rejected, at a start of the background rather than at each wake-up, since the
  background was not seen suspended.
- Idle suspension: in 63 seconds with the native port open, and with the host gone, Firefox did
  not suspend the background, so it is not a named limit. A measurement of a suspended background
  would reopen it.
- Ties to windows (ADR 0089) and the stopped state of a session (ADR 0069) live in memory and do
  not survive a reload or restart: a window opened from such a tab before is not judged, and a
  stopped session's group is judged by the sites allowed always.
- Once the list holds more than 200 groups, the oldest without a tab are dropped, so a saved group
  reopened after that is not judged; with older groups still open, that can come before 200 newer
  groups were made. An agent session can cause it by opening and closing tabs: each new group of a
  session whose group was closed is stored. A group that still has a tab is never dropped.
- Groups made by a version before this one were never stored, so after the update that brings
  this their tabs are not judged. Groups made from then on are.
- A group id of the fallback shape (a small number per browser run, H3) could name another group
  after a restart. The guard would then stop files in that group's tabs that the sites allowed
  always do not allow: more stopping, never more reach for the agent. Every group measured had
  the timestamp shape.
- While the stored list cannot be read, a tab of a group from before is judged as no session's,
  and its files load. Refusing every grouped tab's files then would stop the user's own downloads
  in their own groups, and without the list the guard cannot tell its old groups from them; a
  storage that fails to read also fails every settings read.
- With a remembered group's tab open, the listener is there from the background's start, so every
  page and frame load in any tab passes it: 0 to 6.5 ms more per load (medians, run 3), and no
  wait for a background waking up, since it was never suspended.
- One storage read and one write per group created.
