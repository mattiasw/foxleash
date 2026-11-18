# 0085: Request bodies are read only in a running session's tabs, within a time allowance

**Status:** Accepted, 2026-11-18. Amends
[0070](0070-read-network-hides-request-body-lengths.md), superseding its cost consequence, and
[0067](0067-read-network-shows-request-body-shapes-without-values.md).

## Context

Since [0070](0070-read-network-hides-request-body-lengths.md) the background shapes every request
body Firefox gives, up to 16,777,216 bytes of raw JSON, synchronously inside `onBeforeRequest`: for
every recorded request and for every top-level request of every tab. 0070 accepted that cost and
named what would reopen it: Foxleash stalling on a page that sends large bodies. It does.

Measured with Foxleash in Firefox 156.0.1:

- A 16,700,019-byte flat JSON body takes 1.1 to 1.3 s to shape.
- A page with no agent session that sent 100 `text/plain` form POSTs of that body, one every
  100 ms, kept the background busy for 119 s, and the extension process grew from 229 to
  2,348 MiB.
- With one session, and the page in a tab outside it, one `tabs_list` took 42,278 ms during a
  burst of 40 such submits.
- In a recorded tab, one such body sent with `fetch` made `tabs_list` take 1,336 ms.

Measured in Firefox 160.0.1, headless, with a test add-on that runs the same `bodyShape` behind
one non-blocking `onBeforeRequest` listener with `["requestBody"]`. It compared shaping in the
handler (the code before this record), a queue that holds two bodies and shapes one per zero-delay
timer, and a time allowance, which it ran at 100 ms:

| What was sent | In the handler | Queue of two, one per timer | Time allowance |
|---|---|---|---|
| 3, 6, 12 and 50 small JSON bodies at once (`Promise.all` of `fetch`), five runs each | all shaped | 2 shaped in every run; 1, 4, 10 and 48 left as `other` | all shaped in every run |
| 16,700,015-byte flat JSON bodies, one every 100 ms (one run each) | 8 bodies: a 10 ms timer in the background did not run for 9,281 ms, and a body took up to 1,458 ms | 20 bodies: 5 shaped, 15 `other`; background blocked 6,604 ms of 8,268 ms; five awaited `tabs.query` calls in a row took 2,505 to 5,183 ms (four samples) | 20 bodies: 1 shaped, 19 `other`; blocked 1,692 ms of 8,291 ms, 1,365 ms at most at a time; the same five calls took 4 to 283 ms (four samples) |

With the same test add-on, a listener that reads nothing of a body still costs the background
time for each body Firefox delivers to it:

- A 16,777,216-byte JSON body holding one string: the background's 10 ms timer did not run for 46
  and 61 ms (two runs; 11 to 12 ms when idle). Shaping that body took 51 ms.
- A 1,000,000-byte urlencoded body of 111,112 names: 83 and 71 ms without shaping, 45 ms to shape.

Not measured: whether a page that sends such bodies faster than the background takes them in can
make tool calls wait through the delivery alone.

## Decision

Three bounds, all in `createNetworkLog` (`apps/extension/src/network-log.ts`). None is a size
limit: 0070's rule that Foxleash sets no size edge of its own stays in force.

1. **Firefox is asked for request bodies only while an agent session runs that the user has not
   stopped.** At creation `onBeforeRequest` is added with no extra-info spec. `readingSessions`,
   fed by `access.onRunningChange` and `access.onStop`, holds the sessions that run and are not
   stopped; when it goes from empty to not empty, or back, `onSessionChange` removes the listener
   and `listenForRequests` adds it again, with `["requestBody"]` only while it holds a session. A
   session the user stopped does not count, also while it still runs or when a later request
   records it as running again: no body of its tabs would be read.
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

A body that is not read is recorded as `{ kind: "other" }`, with no `filled`: what `bodyShape`
already gives for a body it cannot read. It says that the request sent a body and nothing about
its bytes. Nothing shapes it later. Whether a request sent a body at all (`details.requestBody` is
not null) is read everywhere; what is in it is not. In the subresource path `bodyOf` runs after the
checks that drop a request the log does not record, so such a request is never read and owes
nothing.

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
it took 250 ms or more, in whole milliseconds. What follows is arithmetic from the figures above,
not a measurement: flat JSON takes about 79 ns a byte to shape (1,325 ms for 16,700,015 bytes), so
a length that differs by n bytes moves the chance that the total crosses a millisecond step by
about n times 0.00008. Telling two lengths one byte apart then takes on the order of 10^8
submissions, and ten bytes apart 10^6, each needing 250 ms or more of shaping in bodies the agent
cannot make up of one long string (a 16 MiB body of one string takes 51 ms). The edge 0070
accepted, Firefox's cut, takes about 24 submissions. How long a tool call took already showed
shaping time before this record.

## Alternatives rejected

- **A bounded queue shaped from a zero-delay timer** (two bodies pending, one shaped per timer).
  Requests arrive faster than a zero-delay timer runs, so every body past the second of an
  ordinary burst became `other` (the first row above), and under a sustained burst the background
  shaped one body per task, so a tool call of several steps waited for as many bodies (the second
  row).
- **A queue only for bodies that arrive during a rest.** It holds up to 16 MiB for each and needs
  shaping and character accounting at read time, for a body that follows 250 ms or more of shaping
  within its rest.
- **A `requestBody` listener per session tab**, which would also spare the delivery of other tabs'
  bodies while a session runs. It means two listeners for one request, or a listener per tab kept
  in step with groups and sessions by events, where a missed event silently loses shapes.
- **Keeping Firefox's copy of a top-level body until the commit.** Up to 16 MiB per tab, and a
  change to the live-document logic.
- **Parsing in a worker.** A new extension file and message plumbing, for a cost the allowance
  bounds.
- **Any size limit.** Rejected by 0070.

## Consequences

- One body still blocks the background for up to about 1.3 s: the costliest body measured is
  16 MiB of raw JSON.
- A body sent before its tab is known to be in a running session's group shows as `other`: a
  request sent before the tab joined, such as a form that a page sends to a new tab, or sent after
  the session ended and before its next request. Tabs Foxleash opens are grouped before they load
  ([0029](0029-tab-open-loads-a-page-in-a-tab-created-unloaded-on-it.md),
  [0066](0066-recording-starts-when-access-begins.md)) and load with a GET.
- A request sent while Firefox was not asked for bodies shows no body at all when its page later
  joins a log.
- A session ends only when the native host says so (`session_end`). One whose host died while it
  ran, and whose client never connects again, counts as running until the extension restarts, and
  Firefox stays asked for bodies as long.
- The allowance is shared. A session's bodies show as `other` after another session's tab, or a
  tab of its own group on a site it may not act on, sent bodies that took 250 ms or more to shape.
- After a very large body, bodies show as `other` for about as long as its shaping took, and for
  10 s at most, also after the clock changed. After the clock is set back, bodies can stay unread
  until 10 s have passed since the first body that followed the change.
- While such a session runs, Firefox still delivers the bodies of every tab to the listener, read
  or not (46 to 83 ms a body above). A page in a tab outside the session can still spend the
  background's time that way; how far was not measured. A listener per session tab would remove
  it (rejected above); revisit on a report of tool calls waiting while a tab outside the session
  sends large bodies.
- Swapping the listener is a remove and an add. A request that begins between them is not
  recorded. No document is live when the first such session starts, or when the last one ends or
  is stopped, so no log loses a request it would have shown, except the page's own request of a
  navigation under way at that instant.
- A tab closed between the seed's reading of the open tabs and its answer leaves one entry in
  `tabGroups` for good. Tab ids are not reused, and an entry there can make Foxleash read a body,
  never show one: `read` still goes through the live document.
- 0067's statement that `onBeforeRequest` asks for `["requestBody"]` now holds only while a session
  runs that the user has not stopped. 0070's cost consequence, that shaping runs for every top-level request in any tab and that
  any site can trigger it with no agent session, no longer holds.
- The result's shape is unchanged, so `PROTOCOL_VERSION` stays 7.
