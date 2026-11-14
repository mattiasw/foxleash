# 0057: Prompts bring the session's own window to the front

**Status:** Accepted, 2026-11-14. Extends [0044](0044-each-agent-session-in-its-own-window.md).

## Context

[0044](0044-each-agent-session-in-its-own-window.md) opens a session's tabs in a window of its
own when the "Open each agent session in its own window" setting is on, and makes no focusing
call. It measured only headless Firefox, and said a desktop measurement showing the user's focus
taken would make us revisit it.

Checked by hand on Ubuntu 26.04, GNOME on Wayland, Firefox from Mozilla's APT repository, a
development build, with the session's window a second window of the same Firefox as the user's:

- **Focus**: the session's window took focus when Firefox opened it, also when its first tab was
  a page on a site allowed beforehand, so no prompt was shown. `focused: false` is not honoured
  there either, as 0044 measured for headless Firefox; Firefox's own reason was not looked into.
  Later `tab_open` calls neither raised the window nor changed the user's selected tab.
- **Attention**: with the session's window behind the user's, a second approval prompt (a new
  site) showed nothing the user noticed, and the agent's call timed out after 30 s. Every prompt
  called only `windows.update(windowId, { drawAttention: true })`; whether that has any visible
  effect there is not established.
- **Tools**: `screenshot`, `wait_for` and `click` worked with the window behind or minimized.

## Decision

**The focus Firefox gives the session's window when it opens it is accepted and documented.**
`openOwnWindow` keeps `windows.create({ url: "about:blank", focused: false })`: desktops that
honour it keep the user's focus. The README, the setting's help text and the add-on listing say
that Firefox may bring the window to the front when it opens it.

**A prompt shown in the session's own window brings that window to the front.**
`SessionGroups.showPromptWindow(session, windowId)` in `session-groups.ts` is called with the
window of the tab a prompt was just loaded and selected in, by the three paths that show a
prompt: `show` in `site-access.ts` (the approval prompt) and `propose` and `askForSites` (the
propose page, and the run page for a recipe or `request_sites`) in `recipe-prompts.ts`. When that
window is the one Foxleash opened for the session, it calls
`windows.update(windowId, { focused: true })`, adding `state: "normal"` only when
`windows.get` reports the window `"minimized"` (a failed read still focuses). In every other case
(a session that has no window of its own, a group the user moved to another window, another
session's window, a session that ended) it calls `{ drawAttention: true }` as before. It never
sends `focused` and `drawAttention` together, and never rejects.

The window Foxleash opened decides, not the setting's current value: a session whose window
opened while the setting was on keeps creating tabs there after the user turns the setting off,
so its prompts still need to reach the user. A session that had the setting off when its first
tab opened behaves exactly as before.

A request that joins a prompt already open (`join` in both files) keeps `drawAttention` only and
selects no tab. Nothing limits how often a request can join an open prompt, so a focusing join
would let an agent raise the window on every call without any user action; the prompt was
brought to the front when it was shown.

Why this is safe enough:

- It grants nothing. Approval is still given only by the user's click or key press on the
  prompt page, and the buttons answer only one full second after the page is both visible and
  focused, disarming at once on blur (`prompt-arming.ts`, `page-ui.ts`). A pointer press or an
  Enter or Space key press records whether it started armed, so one aimed at the user's window
  in the first second after the prompt came to the front answers nothing.
- No prompt page puts initial focus on an answer button: the pages focus only their status
  element, after an answer or when the request ended, or a field after the user's own save.
- How often an agent can pull the user's focus is bounded per session: one prompt at a time;
  the agent cannot close or load over its own prompt tab, so it cannot dismiss a prompt to open
  the next; joining only draws attention; and three refused or closed site prompts, or three
  discarded, refused or closed recipe pages, end the asking. Each further focus pull is a new
  question the user answered, or an earlier one they closed. A new MCP session starts new
  budgets, as for prompts before, and with the setting on its new window takes focus anyway.
- No call ever focuses the user's window, and no permission is added.

The keyboard is the remaining gap. Within Firefox this is the exposure the setting off already
has: a prompt is selected in whichever window holds the session's group, often the one the user
types in. From another application it is new, on desktops that let Firefox take focus from it.
The arming guard stops a key press in the first second, but Tab moves focus without counting as
a press, so Tab within the first second and Enter or Space after it can answer. The same gap
exists for a prompt selected in the window the user types in, and for a session's first prompt
when its new window takes focus. Hardening the keyboard path of the arming guard is separate
work.

The agent can also change what that window shows. While the prompt is open, `tab_select` of
another tab in the session's group, or `tab_open` of a site already allowed, selects that tab,
so the window that came to the front shows a page the agent chose instead of the question, and
keys typed for another application go to that page. This also happens when Firefox brings the
session's window to the front as it opens it, and, within Firefox, with the setting off, where
these tools change the tab selected in the window the user types in. Keeping the prompt
selected while it is open is separate work.

## Alternatives rejected

- **Showing prompts in the user's window**: breaks
  [0030](0030-approval-prompt-tab-created-unloaded-on-the-prompt.md), where the prompt tab,
  created unloaded in the session's group, becomes the page; it would need tabs moved between
  windows after the answer, and it changes the user's selected tab, which the setting exists to
  avoid.
- **A badge on the toolbar button in every window**: as passive as `drawAttention`, which the
  user did not notice.
- **A desktop notification**: needs the `notifications` permission, a listing change and the
  maintainer's decision.
- **Minimizing the new window**: unmeasured, and it hides the first prompt.
- **Focusing the user's window again after opening the session's**: rejected in 0044; it
  misfires when the user switched windows meanwhile, and a Wayland compositor may refuse it.
- **`drawAttention` as well as `focused`**: where the window comes to the front it adds nothing;
  on the measured desktop the hint showed nothing the user noticed; whether it shows anything
  where a desktop refuses the focusing call is not measured.
- **`state: "normal"` with every focusing call**: it also un-maximizes a maximized window and
  leaves full screen.
- **Focusing on a join**: unbounded, as above.

## Consequences

The user's focus moves to the session's window when Firefox opens it, once per window, and when
a prompt is shown in it, bounded as above; the keyboard gap above stays until the arming guard's
keyboard path is hardened, and the agent's tab selection stays until the prompt is kept
selected. A window that was maximized before it was minimized comes back at its normal size, and
Firefox may wait up to 2 s for a minimized window to be restored before the call returns; the
30 s wait for the answer starts before the page loads, so the delay does not lengthen it. On a
desktop that refuses an application's focusing call, the prompt may still stay behind (the
desktop may show a notice that Firefox is ready instead); there is no measurement of that yet,
and one showing it would make us revisit this. The end-to-end tests check the focus in headless
Firefox, for a window behind the user's and for a minimized one.
