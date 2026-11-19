# 0096: A download a load refused is also reported to a load of its address heard after it

**Status:** Accepted, 2026-11-19. Amends
[0092](0092-file-guard-cancels-downloads-from-loads-whose-headers-never-came.md): whom a refusal
by a load is recorded for.

## Context

ADR 0092's second layer judges a download, at its `downloads.onCreated`, against the kept loads
(hops) of its address, and records a refusal only for the tab and frame of the hop that refused
it. A closed tab's hops stay matchable for `HOP_GRACE_MS` (2 s), and a hop that refused a download
is not used up.

An agent can click a link to an address that the service worker of a site the session may not act
on answers with a file, and then, within 2 s, `navigate` or `tab_open` to the same address. When the
second load's `onBeforeRequest` reaches the background after its download's `onCreated`, which ADR
0092 measured in 9 of 44 single loads, the earlier tab's hop refuses the download first, and the
refusal is recorded for that tab alone. The tab that is waiting for its load never hears of it:
`wait-for-load.ts` listens for a refusal in its tab's top frame, the load commits no document, and
the call fails after 30 s as a timeout instead of at once with the file refused. The end-to-end
specs for this case timed out intermittently on both pinned Firefox versions; nothing was saved.

The late load can arrive in two windows: while the download is still being judged (the earlier
hop's verdict resolves first, and the late hop's own judgement finds the download already
refused), and after the download was refused, when no judgement of it runs any more.

## Decision

In `createFileGuard` (`apps/extension/src/file-guard.ts`), a download refused by a hop (not by a
flood mark, and not a file a page built itself) is also reported, once per tab and frame, to each
load of its address that began no later than the download's `startTime`, was heard after the
download's `onCreated` and within `HOP_GRACE_MS` of it, and whose own verdict refuses the address;
only when the refusal ended with the file gone.

- `Download.early` holds the hops that matched the download at its `onCreated`, its candidates
  then. A refusal is recorded for one of them only when it refused the download itself.
- A download a hop refused is kept in `refusedDownloads` for `HOP_GRACE_MS` from its `onCreated`,
  pruned as `unmatched` is, with `Download.told`, the tab and frame pairs its refusal is recorded
  for, seeded with the refusing hop's.
- `tell` judges a late hop with the same `verdictOf` as the refusal, and only when that refuses
  marks its tab and frame in `told`, in the same synchronous step as the check, then records it
  through `refused()` (its tied tab's opener hears of it too). It runs for a kept hop in `onHop`,
  for a tab's matching hops when its lookup judged it in `looked()`, and, in the first window, in
  `byHops` for the hops whose judgement found the download already refused, awaited there so
  `settled()` covers it. `onHop`'s and `looked()`'s calls are tracked the same way.
- `refuse()` resolves to whether the file is gone, and a late report waits for it.

Which downloads are cancelled and have their file removed, and when, does not change.

## Alternatives rejected

- **Making the specs wait `HOP_GRACE_MS` between tests.** It hides a case an agent meets: a click
  and then a `navigate` to the same address within 2 s.
- **Recording the refusal for every matching hop at refusal time.** It would add refusals to other
  tabs' act results, and no measured case needed it.
- **Holding the cancel until the download's own hop arrives.** Firefox would write the file
  meanwhile.
- **Marking the tab and frame before the verdict, and unmarking them when it does not refuse.** A
  concurrent path for the same tab and frame that sees the mark meanwhile skips, and when the first
  verdict then does not refuse, nothing is ever recorded.

## Consequences

A tab whose load of an address starts before a download of it, and is heard within 2 s after the
download's `onCreated`, hears of the refusal even if that download came from another tab. If that
load in fact became a page, the agent gets a `file_refused` for a page of a site its session may
not act on; nothing is saved or sent. This is the same imprecision as the rule that a hop that
refused a download is not used up.

A load heard before the download hears of the refusal only when it refused the download itself.
An older one is not judged once a newer load of the address refused it, and one whose verdict
came after another load's refusal is not told: a `navigate` waiting on it still times out.
Refusals by a flood mark, and of a file a page built itself, stay reported to nobody.
