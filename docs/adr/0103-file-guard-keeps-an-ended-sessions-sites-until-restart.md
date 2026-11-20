# 0103: The file guard keeps an ended session's sites in memory until the background restarts

**Status:** Accepted, 2026-11-20. Amends
[0081](0081-session-tabs-cancel-files-from-sites-the-session-may-not-act-on.md) and
[0091](0091-file-guard-remembers-session-groups-across-restarts.md): their consequence that the
tabs left in an ended session's group are judged by the sites allowed always now holds only after
a Firefox restart, or an update or reload of the add-on. Amends
[0094](0094-file-guard-and-files-a-page-builds-itself.md): its Blob judgement for an ended
session's tab uses the same remembered sites.

## Context

The user allows a site (B) for one agent session only ("Allow this session"). The session ends,
as when the agent's program exits, and one of its tabs stays open in the session's tab group,
showing a page of B. `endSession` in `apps/extension/src/site-access.ts` deletes the session's
answers, so `view(session)` then allows only the sites stored as allowed always. The file guard
keeps judging the tabs left in the group as that session's (`groups.rememberedSessionOf` in
`sessionOfTab`, ADR 0091), and asked `view(session).allowed(url)` in the header layer (`judge`),
the hop layer (`verdictOf`) and `allows`, which the built-file layer (ADR 0094) and the flood marks
use. So B, which the user's click allowed for that session, became a site the session may not act
on:

1. `byFrames` queries every open tab with no time bound, found the left-over tab showing B, and
   cancelled every Blob file of B in any tab, including the user's own tabs outside every group,
   about 10 ms after Firefox started it and with no message, for as long as that tab stayed open.
   The usual "Export CSV" button of a site builds such a file.
2. In the left-over tab itself, a file of B loaded by address was stopped.

## Decision

The guard keeps, per ended session, in memory only and for judging files only, the sites the
session was allowed for itself when it ended: `endedSites` in `createFileGuard`
(`apps/extension/src/file-guard.ts`), filled by `keepEnded` from `access.onWithdraw` with the cause
`"end"`. `onWithdraw` listeners get the cause as a new third argument, `WithdrawCause` in
`site-access.ts`: `"forget"` when the user withdrew the site, `"end"` when the session ended,
`"stop"` when the user stopped it.

`allows(session, url)` is the one judgement of a session's site for files, used by the header,
hop and built-file layers and the flood marks: it reads the session's view anew, passes what the
view allows, and otherwise passes a site in the session's `endedSites` entry that is not on the
blocklist, read after the view. A view that throws, as it does for a session the user stopped,
refuses, so a stopped session's tabs refuse every file, remembered sites included.

The memory is dropped:

- for the whole session when it runs again (`dropEnded`, on `onRunningChange` with
  `running(session)` true): a session that reconnects with the same id asks again for its sites;
- for a site the user withdrew (`"forget"` or `"stop"`);
- for the oldest ended session once more than `MAX_REMEMBERED_GROUPS` (200) ended sessions with
  such a site are kept, oldest end first;
- entirely after a Firefox restart, or an update or reload of the add-on: nothing is stored.

Nothing outside the file guard reads it: navigation checks, `tabInfo` redaction, page reading and
approval are unchanged.

## Alternatives rejected

- **Keeping the memory in storage across restarts.** A session-only grant would outlive the
  browser session that the user's "Allow this session" click meant, and storage would hold sites
  the user never chose to keep.
- **Leaving ended sessions' tabs out of the built-file layer.** An ended session's tab could then
  build Blob files of sites it was never allowed.
- **Ending the guard for a group when its session ends.** The left-over tab could then load any
  file of any site, the gap ADRs 0081 and 0091 close.
- **Telling the cause from `access.running(session)` in the guard.** A `forget` on a session that
  holds answers but is not running would look like an end, and keep a site the user withdrew.

## Consequences

- A file of a remembered site saved from the left-over tab lands in the download folder, as it
  already does from any tab outside a group. A Blob file of the user's own from that site, in any
  tab, is no longer cancelled while that tab shows it.
- After a Firefox restart, or an update or reload of the add-on, the remembered group is judged by
  the sites allowed always again (ADR 0091): a file of that site is again stopped in the left-over
  tab, and a Blob file of the user's own from that site is again cancelled in any tab while that
  tab shows it, or showed it in the last 60 seconds.
- Past 200 ended sessions, the oldest one's tabs fall back to the same, which fails closed. The
  cap counts ends, not groups: unlike ADR 0091's list, which never drops a group that still has a
  tab, it drops the oldest end even when that session's left-over tab is still open, so a tab kept
  open through 200 later ends of sessions with a session-only site is judged by the sites allowed
  always again. Entering the memory takes a site the user allowed for that session by a click, so
  a page or an agent cannot push an entry out without 200 such ended sessions.
- Once the session ended, the settings page no longer lists it, so the user cannot withdraw a
  remembered site there; a Forget clicked on a settings page that still shows the session from
  before its end finds no answers and drops nothing, while Stop there still refuses every file.
  Putting the site on the blocklist, moving the tab out of the group or closing it ends it. The
  memory grants nothing beyond file judgements.
- Memory cost: one set of sites per ended session, at most 200 sessions.
