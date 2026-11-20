# 0085: Request bodies are read only in a running session's tabs, within a time allowance

**Status:** Accepted, 2026-11-18. Amends
[0070](0070-read-network-hides-request-body-lengths.md), superseding its cost consequence, and
[0067](0067-read-network-shows-request-body-shapes-without-values.md).

Amended 2026-11-20: Firefox is asked for bodies by one listener per session tab instead of one listener for every tab while a session runs, because form posts of many names from any tab grew the extension process by gigabytes; a page in a session tab can still grow it.

## Context

Since [0070](0070-read-network-hides-request-body-lengths.md) the background shapes every request
body Firefox gives, up to 16,777,216 bytes of raw JSON, synchronously inside `onBeforeRequest`: for
every recorded request and for every top-level request of every tab. 0070 accepted that cost and
named what would reopen it: Foxleash stalling on a page that sends large bodies. It does: such a
body takes 1.1 to 1.3 s to shape, a page with no agent session kept the background busy for 119 s,
and with the page in a tab outside a session one `tabs_list` took 42 s
([measurements](../measurements/request-bodies.md)).

Delivery costs too. A listener that reads nothing of a body still costs the background 45 to 83 ms
for each large body, and while one `<all_urls>` listener asked for bodies, a 1,000,000-byte
urlencoded form of 111,112 names submitted every 50 ms from any tab grew the extension process,
which every add-on shares, by gigabytes, also from a tab outside the session (same file).

## Decision

Three bounds, all in `createNetworkLog` (`apps/extension/src/network-log.ts`). None is a size
limit: 0070's rule that Foxleash sets no size edge of its own stays in force.

1. **Firefox is asked for request bodies only for the tabs of a running session's group that the
   user has not stopped.** An `<all_urls>` `onBeforeRequest` listener with
   no extra-info spec, added at creation and never removed, records requests. `bodyListeners`
   holds one more non-blocking listener per such tab, a function of its own, with
   `{ urls: ["<all_urls>"], tabId }` and `["requestBody"]`. Firefox checks a listener's tab filter
   before it builds a body, and builds one only for a listener that asks for it
   (`runChannelListener` in `WebRequest.sys.mjs`), so it builds and delivers no body for other tabs.
   `syncBodies(tabId)` adds or removes the tab's listener to match `inRunningSession` (see 2). It
   runs after each tab event updates `tabGroups`, from the seed, for every tab on
   `access.onRunningChange` and `access.onStop`, and for the request's tab first in the `<all_urls>`
   listener. That last call recovers from a missed event: the log hears nothing when
   `groups.sessionOf` learns a group. A missed event costs the bodies of the requests Firefox
   dispatches for the tab before Foxleash handles its next request; for a tab that left, Firefox
   drops the deliveries queued for a removed listener unread.

   The body listener only fills in a body, through `update`: on the tab's page entry or the open
   entry of its current log for `requestId`, correcting the characters counted against the log's
   bound. A request with no entry is not read and owes nothing. This relies on Firefox calling the
   `<all_urls>` listener first. In Firefox 153.7.0esr, 156.0.1 and 160.0.1, `HttpObserverManager`
   keeps each event's listeners in a `Map` and calls them in the order added, each extension
   `addListener` registers a callback of its own (`registerEvent` in `ext-webRequest.js`), and the
   extension process runs deliveries in the order sent.

   **No bound on delivery in a session tab.** A page there can still make Firefox deliver bodies
   faster than the background takes them. A form of many names posted from a session tab grew the
   extension process by about 60 to 90 MiB a second for as long as the page sent, and removing
   every body listener for a while after a late delivery did not stop it
   ([measurements](../measurements/request-bodies.md#this-change-on-firefox-16001-2026-11-20)), so nothing of the kind is kept.
2. **A body is read only for a tab in the group of a running session the user has not stopped.**
   `tabGroups` maps each tab to its group: set from `tabs.onCreated`, from every `tabs.onUpdated`
   (as `changeInfo.groupId ?? tab.groupId ?? -1`, since Firefox does not always name a group
   change), to none on `tabs.onDetached`, deleted on `tabs.onRemoved`, and seeded once by
   `tabs.query({})` for tabs no event has set yet. `inRunningSession` asks `groups.sessionOf`,
   `access.running` and `access.stopped` at the time of each request. A tab the map does not know
   counts as outside.
3. **For those tabs, a body is read only while shaping has time to spare.** `bodyOf` keeps `owed`,
   the milliseconds spent shaping that have not passed again since, one figure for every tab
   because the background has one thread. Each millisecond the clock moves forward pays one off. A
   body that arrives while `owed` is `SHAPING_ALLOWANCE_MS` (250) or more is not read. The time a
   reading takes is added, also when the reading fails, and `owed` is capped at
   `SHAPING_ALLOWANCE_MS + MAX_SHAPING_REST_MS - 1`, so a body that arrives `MAX_SHAPING_REST_MS`
   (10,000 ms) after any reading is read, however far the clock jumped forward during it. A clock
   set back pays nothing off and adds nothing: what is owed is then counted from the first body
   after it.

A body that 2 or 3 leaves unread is recorded as `{ kind: "other" }`, with no `filled`: what `bodyShape`
already gives for a body it cannot read. It says that the request sent a body and nothing about
its bytes. Nothing shapes it later.

Why these numbers. 250 ms is above what ordinary bursts cost (50 small bodies took 0 or 1 ms each)
and above one 16 MiB body holding one string (51 ms), so two such bodies in a row keep their
shapes also on a machine three times slower. It is also the most shaping a tool call waits for on
top of one body. Any time that passes pays off, also time the background spent on other work, so
the rule holds shaping to about half of the time, not the background's whole load. 10 s bounds what
a jump of the clock during a reading (a laptop suspended in the middle of one) can cost: bodies
stay unread for 10 s at most, not for the length of the jump. The clock is the background's
`Date.now()`.

### Why this is not a size edge

0070 rejected a random limit because it still leaks statistically, so the same question is asked
here. A body is never left out for its own size. A later body is left out when the bodies before
it took 250 ms or more, in whole milliseconds. What follows is arithmetic from the measurements,
not a measurement: flat JSON takes about 79 ns a byte to shape (1,325 ms for 16,700,015 bytes), so
a length that differs by n bytes moves the chance that the total crosses a millisecond step by
about n times 0.00008. Telling two lengths one byte apart then takes on the order of 10^8
submissions, and ten bytes apart 10^6, each needing 250 ms or more of shaping in bodies the agent
cannot make up of one long string (a 16 MiB body of one string takes 51 ms). The edge 0070
accepted, Firefox's cut, takes about 24 submissions. How long a tool call took already showed
shaping time before this record.

## Alternatives rejected

- **A bounded queue shaped from a zero-delay timer.** Every body past the second of an ordinary
  burst became `other`, and under a sustained burst a tool call of several steps waited for as
  many bodies.
- **A queue only for bodies the allowance leaves unread.** It holds up to 16 MiB for each and needs
  shaping and character accounting at read time.
- **One `<all_urls>` listener with `["requestBody"]` while a session runs**, this record's first
  decision. Firefox then builds and delivers every tab's bodies, which grew the extension process
  by gigabytes from a tab outside the session.
- **Removing every body listener for up to 10 s once a body arrives 1 s late.** From a session
  tab the extension process still grew by 1,638 MiB in 25 s, and by 1,132 MiB with a 250 ms limit,
  which also left 18 of 20 large `fetch` bodies with none ([measurements](../measurements/request-bodies.md#this-change-on-firefox-16001-2026-11-20)).
- **Keeping Firefox's copy of a top-level body until the commit.** Up to 16 MiB per tab, and a
  change to the live-document logic.
- **Parsing in a worker.** A new extension file and message plumbing, for a cost the allowance
  bounds.
- **Any size limit.** Rejected by 0070.

## Consequences

- One body still blocks the background for up to about 1.3 s: the costliest body measured is
  16 MiB of raw JSON.
- A request sent before its tab's body listener existed shows no body at all: one sent before the
  tab joined a running session's group, such as a form that a page sends to a new tab, after the
  session ended or was stopped, or by a tab whose group event Foxleash missed. Tabs Foxleash opens
  are grouped before they load ([0029](0029-tab-open-loads-a-page-in-a-tab-created-unloaded-on-it.md),
  [0066](0066-recording-starts-when-access-begins.md)) and load with a GET.
- A page in a session tab, including a frame from any site or a page on a site the session may
  not act on, can still grow the extension process, which every add-on shares, for as long as it
  sends: about 60 to 90 MiB a second with a form of many names, in headless Firefox 160.0.1. Why
  the deliveries outrun the background was not measured.
- A session ends only when the native host says so (`session_end`). One whose host died while it
  ran, and whose client never connects again, counts as running until the extension restarts, and
  Firefox stays asked for its tabs' bodies as long.
- The allowance is shared. A session's bodies show as `other` after another session's tab, or a
  tab of its own group on a site it may not act on, sent bodies that took 250 ms or more to shape.
- After a very large body, bodies show as `other` for about as long as its shaping took, and for
  10 s at most, also after the clock changed. After the clock is set back, bodies can stay unread
  until 10 s have passed since the first body that followed the change.
- A tab closed between the seed's reading of the open tabs and its answer leaves one entry in
  `tabGroups` for good, and in a running session's group a body listener until the session ends
  or is stopped. Tab ids are not reused, and an entry there can make Foxleash read a body, never
  show one: `read` still goes through the live document.
- 0067's statement that `onBeforeRequest` asks for `["requestBody"]` now holds only for the tabs
  of a running session the user has not stopped. 0070's cost consequence, that
  shaping runs for every top-level request in any tab and that any site can trigger it with no
  agent session, no longer holds.
- The result's shape is unchanged, so `PROTOCOL_VERSION` stays 7.
