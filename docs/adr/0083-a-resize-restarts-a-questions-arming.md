# 0083: A resize restarts a question's arming, and resize_window waits for the session's question

**Status:** Accepted, 2026-11-18. Amends
[0062](0062-an-open-question-guards-only-the-tab-selects-foxleash-makes.md): refuses
`resize_window` while the session's question is open, which replaces its "Not a select" entry and
its accepted case for `resize_window`.

## Context

A question page (the site prompt `approve.html`, the recipe page `propose.html`, the run and
site-request page `run.html`) arms its answer buttons only after a full second of being shown and
focused, so a click aimed at what the page showed before cannot answer what it shows now. A resize
of the page's viewport moves the buttons without hiding the page or taking its focus, and nothing
restarted that second.

Measured in Firefox 156.0.1 headless: 16 resizes down to the 500 px minimum moved a site
prompt's buttons 72 px down (their top from 331 to 403), and they stayed armed (0 unarmed);
no button's centre landed inside another button. With a 24 px root font size (a stand-in for
Firefox's font size setting or a zoom of about 150 %, neither measured) the button row wraps, and
a resize from 600 to 660 px put "Always allow" where "Don't allow" was: 40 such
centre-in-another-button pairs, with 0 buttons unarmed right after the resize. A trusted click at
that point right after the resize answered Always allow.

[0062](0062-an-open-question-guards-only-the-tab-selects-foxleash-makes.md) listed
`resize_window`'s `windows.update` under "Not a select", and in its accepted list `resize_window`
restoring the group's window while a question is open. Both entries looked only at selects and
focus, not at what a resize does to the question's layout.

## Decision

**The page rule.** Any resize of a question page's viewport starts its arming second again:
`armButtons` in `apps/extension/src/page-ui.ts` adds a `resize` listener in `watch()` that calls
`rearm`. A pointer press under way at the resize then does not answer, and a Tab path counted
before the resize no longer counts, so Enter or Space answers only along a new Tab path. The last
part protects nothing by itself (Enter or Space answers the focused button wherever it is) and has
a cost: after a resize a keyboard user must Tab to the button again, and a refused Enter or Space
sends focus to the question with the page's message to wait and use Tab. A keyboard zoom (Ctrl +
or Ctrl -) already ends the Tab path today, through the key rule. A resize by the window manager,
another session or the user, and a zoom by mouse or menu if Firefox fires `resize` for it, now
end it too. Accepted: rare, recoverable, and announced. All three pages call
`armButtons(...).watch()`, so all three get the rule.

**The tool rule.** `resize_window` is refused while the session's own site prompt or recipe page
is open, wherever that question is shown, also after the user moved its tab out of the session's
group. `resizeWindow` in `apps/extension/src/handlers.ts` calls `keepPromptInView` with no tab
right before `windows.update`, after the group lookup and the ended-session check with no await in
between, so a question that opened during the lookup is seen. The errors are the existing
`approval_pending` and `recipe_prompt_open`, with the wordings `tab_select` gives; no error code
and no protocol change. This replaces 0062's "Not a select" entry for `resize_window` and its
accepted case of `resize_window` restoring the group's window after the user emptied the group.

**Other sessions.** Another session's `resize_window` of a window it shares with the question is
not refused, for 0062's reasons about other sessions: refusing it means tracking which window
shows each question, and one session's open question would stall every other session's
`resize_window`. The page rule covers it: whoever resizes, the buttons are unarmed for a second
afterwards.

## Alternatives rejected

- Only the page rule: the asking session could resize the window every second and keep its own
  question from ever arming.
- Only the tool rule: it leaves other sessions' resizes and the user's own resize or zoom.
- Refusing every session's resize of the question's window: 0062's reasons above.
- Comparing the viewport size at each press and click, to close the interval below: no test can
  reach that interval, so it would be code no test fails without, for a whole press and release
  inside at most one rendering update.
- A re-arm that keeps a counted Tab path across a resize: a change to the arming logic, for the
  keyboard cost bounded above.

## Consequences

Not covered, and not measured:

- Whether Firefox fires `resize` for the user's own zoom (Ctrl + or Ctrl -, Ctrl and the mouse
  wheel) and for a pinch zoom, which changes only the visual viewport.
- A whole pointer press and release that Firefox delivers after the viewport changed but before
  the page's `resize` event, which the HTML standard fires in the next rendering update; whether
  Firefox delivers input in that interval is not measured. Only a press that starts inside that
  interval can be misdirected: a press that began before it targets the button the user pressed
  on, so its click lands on that button or, when the release is over another element, on their
  common ancestor, which answers nothing.
- Whether another session's `resize_window` of a maximized window, to exactly its maximized size,
  moves the window when it returns it to its normal state without changing the viewport's size,
  which would move the buttons with no `resize`.

Moving a window without resizing it fires no `resize`, and no tool asks Firefox to move one.
Another session that keeps resizing a shared window keeps the question unarmed while it does; the
user sees the window change size.

The end-to-end tests in `e2e/approval.test.ts` and `e2e/recipes.test.ts` pin the page rule and
the refusal for all three pages, and on the site prompt a press held across a resize.
