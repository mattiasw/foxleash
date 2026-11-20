# 0102: The file guard ties a window by the group its opener was seen in, also once the opener is gone

**Status:** Accepted, 2026-11-20. Amends
[0089](0089-file-guard-ties-windows-to-the-tab-that-opened-them.md): its consequence that a
window whose opening tab closes within the moment of its lookup is not covered; such a window is
now judged as the session of the group that tab was in. Amends
[0094](0094-file-guard-and-files-a-page-builds-itself.md): beside the `data:` file, a page of a
site the session may not act on that saves its own address as a file is named as still saved.

## Context

ADR 0089 ties a window that a page in a session's tab opens to the session through
`webNavigation.onCreatedNavigationTarget`: the guard looks the source tab up with `tabs.get` and
judges the window as the source's session. A page on an approved site, in a tab that `tab_open`
opened, can open a window on a file of another site and close its own tab in the same task:

```js
addEventListener("load", () => { window.open("<B>/export", "_blank", "popup,width=400,height=300"); window.close(); })
```

A tab with one entry in its history may be closed by its own script, and pop-ups must be allowed
for the approved site. Measured on Firefox 160.0.1 and 153.7.0esr headless: Firefox saved B's
file, fetched with the cookies it sends B, in 5 of 5 runs on each. By the time the guard looks
the source up, Firefox has forgotten the tab, so `tabs.get` fails, and the guard kept no record of
the group the tab was in; its only fallback was the source's own tie, which a tab in a group,
not opened from another tab, does not have. A chain of windows whose middle tab closes saved 0 of
5: that fallback held, which also shows the event arrives with a valid `sourceTabId` before the
source's removal is processed.

## Decision

In `createFileGuard` (`apps/extension/src/file-guard.ts`):

- `tabGroups` holds each tab's group, -1 for none, as its latest event showed it, kept while the
  tab is open and filled whether or not the guard listens yet: from `tabs.onCreated`, from
  `tabs.onUpdated` read as `changeInfo.groupId ?? tab.groupId ?? -1` (Firefox does not always
  name a change of group), -1 at `tabs.onDetached` (a group stays in its window), and from the
  start-up `tabs.query` for tabs with no entry yet, since an event is newer than the query's
  answer. `tabs.onRemoved` deletes the entry.
- `goneTabs` keeps a closed tab's group, with its `opened` entry, from `tabs.onRemoved` on: every
  tab closed in the last `HOP_GRACE_MS` (2 seconds), and past that the `MAX_GONE_TABS` (200)
  closed last. Firefox never reuses a tab id, so only a window the closed tab opened names it.
- `tie`, at `onCreatedNavigationTarget`, reads the source's group (from `goneTabs` when the tab
  closed, else from `tabGroups`), that group's session, and the source's own tie (from `opened`,
  else from `goneTabs`), synchronously: the source may be the group's last tab, and the group
  and its session can be gone by the time a lookup fails.
- When `tabs.get` of the source succeeds and names a session, its live answer wins, as before.
  When it fails, or finds the source in no session's group, `tieOfGone` decides, in the order
  `sessionOfTab` uses for a live tab: the session of the group read at the event, then the
  source's own tie, then the session the extension remembers for that group (ADR 0091). The
  window's opener, for `refusedSince`, is the source.
- A gone source whose group was none, not a session's, or never seen gives no tie.

Also documented as a limit, with no code change: a page of a site the session may not act on
that saves its own address as a file, for example with a download link to itself. The header
layer lets that address's answer through as a web page, and the load layer drops the load when
its headers come.

## Alternatives rejected

- **Failing closed for any window whose opener is gone.** It would stop a user's own download
  pop-ups whose opener closes, in every tab.
- **Keeping a page load until its commit, to catch the self-saved address.** It covers only a
  download within `HOP_GRACE_MS` of the commit, and a page can wait longer.
- **Sharing the network log's map of tab groups.** It would change the network log, whose map ADR
  0085 describes, and that map forgets a tab at `tabs.onRemoved`, before a late tie reads it.
- **Keeping a closed tab's group for `HOP_GRACE_MS` only.** Firefox reports a window that
  `window.open` waits for before it processes the opener's close of its own tab, but how late it
  can report a window it opens without waiting, such as one opened with `noopener`, is not
  measured. Keeping the last 200 costs nothing in judgement, since only a window the closed tab
  opened names it.

## Consequences

- A window opened from a tab of a session's group is covered also when the tab closes at once.
  A window from a tab the user dragged out of the group while the guard looked it up is judged as
  the group it was opened from: the change only ties more windows, never fewer.
- Not covered: a window opened from a tab whose group the guard never saw, which happens only
  when no event for the tab came since the guard started and the start-up query failed or had not
  answered yet; a window that no tab's page opens, such as one a service worker opens when the
  user clicks its notification; and a window whose event comes more than 2 seconds after its
  source closed and after more than 200 other tabs closed.
- The guard holds one number per open tab, and one entry per tab among the last 200 closed and
  those closed in the last 2 seconds.
- A refusal in such a window is recorded for the gone opener's id too, as for any tie, within the
  existing cap on tabs with refusals.
