# 0066: Recording starts when access to the shown page begins

**Status:** Accepted, 2026-11-16. Supersedes the consequence of
[0015](0015-console-recorder-in-the-page-world.md) and
[0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md) that a page
that loaded before the user approved its site, or whose access was interrupted, is not recorded
until it loads again.

## Context

`read_console` and `read_network` recorded a page only from its top-frame commit in a tab the
session could act on (`live-documents.ts`). A page that loaded before its session could act on
its site answered `recording: false` until it loaded again, and the only way to load it again
was `navigate`'s reload, which skips the cache ([0021](0021-autofilled-fields-are-protected.md)) and
clears every form field. A user who prepared a form and then brought the agent in lost what they
had typed, and so did a user who moved a tab into the agent's group or approved its site later.

The listing promises that page content "comes only from what a tab showed or loaded while its
page was on a site you approved". Whatever starts recording later must keep that: nothing from
before the access began and nothing from a gap in it may reach the agent.

## Decision

A live document now starts in one of two ways, recorded in `LiveDocument.startedBy`: `"commit"`,
as before, and `"grant"`, a catch-up for the document a tab already shows.

- **Triggers.** `SiteAccess.onGrant` reports each site a user's click grants a session: a prompt
  answered once (only for a site not already allowed), or always once the answer is saved, and
  each site `allowForSession` grants (`request_sites`, a recipe's sites). It grants nothing
  itself. A grant catches up every tab of that session; a storage change other than recipes and
  the tag mark (an always answer, a settings change) catches up every tab of every session; a tab
  whose group differs from the last one an update showed it in (Firefox does not always name the
  change) catches up that tab; so does a drop for a group move (the tab may have joined another
  session's group) and a withdrawal's drop (a stored approval may still allow the site). Each
  catch-up touches only tabs with no live document, and the gate decides.
- **The catch-up** (`catchUp` in `live-documents.ts`) reads the tab's group, then frame 0 of
  `webNavigation.getAllFrames`, whose URL is the committed document's (the tab's own can be a
  pending navigation's), and passes that URL through the page tools' gate. After each await it
  stops on a newer commit, a live document of the tab, the tab's removal or a newer catch-up for
  the tab. A later trigger supersedes a catch-up under way; a site change of the tab, a withdrawal
  and a storage change restart it, so none keeps a gate answer read before them. After it sets
  the live document it rechecks group and gate, as a commit does. A trigger that arrives while a
  commit's check is undecided marks the tab, and the catch-up runs once that check ends without a
  live document. A grant, a storage change or a withdrawal marks every tab under check at once:
  its gate may have read access from before the change, so the check makes nothing live, and the
  catch-up once it ends reads access again and starts empty.
- **Every grant starts empty, and a gap still drops.** A grant-started document is dropped at
  every interruption a commit-started one is, and the next grant starts a new, empty one.
  - Network (`network-log.ts`): `onDecided` replaces the tab's log with an empty one created at
    `now()`; requests that started before it are left out by the existing start-time check, the
    later events of requests it does not hold change nothing, and no page request is attached.
  - Console (`console-recording.ts`): one injection of the recorder with `clear` true, no retries.
    In a document without a recorder it starts one; in a document with one it dispatches
    `CONSOLE_CLEAR_EVENT`, the recorder empties its records and answers synchronously with
    `CONSOLE_CLEARED_EVENT`, and the injection returns `"cleared"` only when it heard the answer.
    Only `"started"` or `"cleared"`, in the document the catch-up read (when Firefox names one),
    with the live document unchanged, makes the recording live; anything else drops it.
- **`since`.** Both results carry `since` (ms since the epoch, the background's clock, never the
  page's) whenever `recording` is true. For the console it is when the injection that started or
  emptied the recorder returned, on the commit path too, which is why a recording is now exposed
  only once its injection landed (before that a read answers `recording: false`, as it did before
  the recorder existed). For the network it is the grant log's creation time, or the commit's
  `timeStamp`, with the page's own request, which starts just before the commit, included.
- `PROTOCOL_VERSION` is unchanged: `since` is an optional result field that an older server
  strips.

## Alternatives rejected

- **Keeping the reload.** It is what this replaces: it clears forms and skips the cache.
- **Keeping the recorder's records and filtering them by their `time` against the grant.** The
  records' times come from the page's clock. A wall-clock step back between a gap and the grant
  would let records from the gap through; clearing does not depend on any clock.
- **A recording that survives a gap in access.** [0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md)
  already rejected it: what a page did while the session could not act on it must not reach the
  agent.

## Consequences

- Requests that started before the grant, the page's own included, are left out, with one
  exception: Firefox reports each redirect hop with a new `onBeforeRequest` under the same request
  id, so a request started before the grant whose next hop is issued after it is recorded from
  that hop. That hop loads after the grant, so the listing's claim holds.
- Messages logged between the grant and the moment the recorder lands or is emptied are missed.
- A request from before the grant whose `onBeforeRequest` reaches the background only after the
  log started, with the wall clock stepped back past the grant meanwhile, would be kept, as 0016
  accepts for commits.
- The page can block the clear (then the tab is not recording) or forge the answer (then it keeps
  only records of what it logged itself, which it could log again after the grant; 0015 already
  accepts that a page can forge its records).
- A tab whose recording stopped without a gap in access (a blocked clear, a site change without a
  commit) starts again, empty, at any later approval, storage change or group change of its
  session.
- Page views (`page-view.ts`, which shares `live-documents.ts`) are now also kept for a
  grant-started document, so an act's view of such a page shows only what changed, and the act
  settle (`act-settle.ts`) now waits on a grant-started page's requests as on a commit-started
  page's.
- Each trigger lists every tab (`tabs.query({})`, as the groups module has no session-to-tab map
  here) and reads each candidate tab; approvals and storage changes are rare and the frequent
  tag-mark write keeps its early return, a group change triggers once per change, and a same-site
  `pushState` does not restart a catch-up.
- A group created for a page that is already loaded may be seen by the catch-up before the
  groups module knows it is the session's; Foxleash creates groups only for tabs it loads
  afterwards, whose commits start their recording.
