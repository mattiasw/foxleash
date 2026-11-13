# 0044: Each agent session can open in its own window

**Status:** Accepted, 2026-11-13.

## Context

A session's first tab opens in the window the user is working in, and every `tab_open` selects
its tab, so an agent working on its own keeps switching the tab the user looks at. Users asked
for the agent's tabs to stay out of their window.

A new window must not undo [0029](0029-tab-open-loads-a-page-in-a-tab-created-unloaded-on-it.md)
and [0030](0030-approval-prompt-tab-created-unloaded-on-the-prompt.md): the tab is created
unloaded on its page or prompt URL, grouped before anything loads in it, and loaded before it
is selected. `windows.create` cannot create a discarded tab, so the window cannot be opened on
the page itself.

Measured in headless Firefox 156.0.1 through the end-to-end harness, calling the extension APIs
from the settings page:

- **A window, then the tab in it** (`windows.create({ url: "about:blank", focused: false })`,
  then `tabs.create({ windowId, url, discarded: true, active: false })`, `tabs.group`, a
  `loadReplace` load, a select, then removing the window's first tab): in 3 of 3 runs the tab
  stayed discarded with no top-frame commit until after `tabs.group`, the group was created in
  the new window, and the page committed only with the load. The window then held only the
  grouped tab. Session history right after the open was the page alone, and again after
  unloading the tab and selecting it, at once and 1.5 s later (n=1).
- **The tab, then moved to a new window** (`tabs.create` discarded in the user's window, then
  `windows.create({ tabId, focused: false })`): the tab arrived loaded, with two top-frame
  commits of the page, before `tabs.group` ran.
- **Focus**: `windows.create({ focused: false })` returned `focused: true` and
  `windows.getLastFocused()` named the new window, in 3 of 3 runs: headless Firefox does not
  honour `focused: false`. With the user's window focused again, a load, a select, removing the
  first tab, a second tab's load and select, and `drawAttention` in the session's window each
  left the user's window focused and its selected tab unchanged.
- **Tools in a window behind another, then minimized** (`state: "minimized"` reported):
  `screenshot`, `click`, `read_page`, a `navigate` reload and a `wait_for` of text a page adds
  2 s after its load all worked; behind: 98, 21, 24, 38 and 2199 ms; minimized: 55, 16, 16, 30
  and 2153 ms.
- **Events**: the new window's first tab fires `tabs.onActivated` while the window opens, and
  the session's tab fires it when selected. `windows.remove` fires `tabs.onRemoved` with
  `isWindowClosing: true` for each tab, then `windows.onRemoved`.

Not measured: a desktop window manager's focus behaviour, and how a desktop throttles a window
behind another or minimized.

## Decision

A setting on the settings page, "Open each agent session in its own window", stored as
`sessionWindow: true` in `storage.local` and absent when off (`settings.ts`). Off is the default
and creates every tab with the same arguments as before.

`SessionGroups.createTab` in `session-groups.ts` creates every new tab of a session (`tab_open`,
the approval prompt, the propose and run pages). With a group, the tab goes to the group's
window. With no group and the setting on, it opens a window for the session with
`windows.create({ url: "about:blank", focused: false })` and creates the tab in it unloaded, as
measured above; the caller then groups, loads and selects it as before. A blank `tab_open`
takes the window's own first tab instead of creating another. Window creation and every create
in the session's window run in the session's queue, so parallel first requests share one
window.

The window's own first tab is removed when another tab in that window is selected, if it is
still blank and in no group. When the session's first tab fails and is removed, leaving only
that first tab, the window is closed. At session end the window is closed when every tab in it
is blank and in the session's group (or is its own first tab) and another normal window stays
open; otherwise the usual rule for the group applies. A window the user closes is forgotten, and
the session's next tab with no group opens a new one. Foxleash makes no focusing call.

## Alternatives rejected

- **Moving the unloaded tab into a new window** (`windows.create({ tabId })`): measured, the
  page loads before it joins the group.
- **Opening the window on the page** (`windows.create({ url })`): the page loads before it joins
  the group, and the tab starts loaded, which the history rule of 0029 avoids.
- **Keeping the window's first blank tab**: a stray tab outside the group, which also keeps the
  window from closing at session end.
- **Focusing the user's window again after opening the session's**: a focusing call that misfires
  when the user switched windows meanwhile.
- **Reusing the window after the session's group is gone**: by then it may hold the user's tabs.

## Consequences

The first tab of a session can now open a window. In headless Firefox that window takes focus
despite `focused: false`; whether a desktop window manager raises it is not known, and a
measurement there showing the user's focus taken would make us revisit this. Two parallel first
requests of one session open one window; one request in flight when its session ends can leave
a window open, as it can leave a group today.
