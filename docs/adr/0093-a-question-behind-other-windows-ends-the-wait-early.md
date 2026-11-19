# 0093: A question behind other windows ends the agent's wait early

**Status:** Accepted, 2026-11-19. Revisits a consequence of
[0057](0057-prompts-bring-the-sessions-own-window-to-the-front.md).

## Context

When Foxleash shows a question (whether to allow a site for `tab_open` or `navigate`, or the run
page for `request_sites` or `start_recipe`), the agent's call waits up to `APPROVAL_WAIT_MS`
(30 s) for the answer. That wait is one fixed timer: nothing checks whether the question reached
the user. [0057](0057-prompts-bring-the-sessions-own-window-to-the-front.md) brings the session's
own window to the front for a question and asks for attention otherwise, and its Consequences
asked for a desktop measurement of whether that is enough.

Measured with Firefox Developer Edition 160.0b5 on Ubuntu 26.04.1, GNOME Shell 50.1 on Wayland,
with "Open each agent session in its own window" on and Firefox behind a terminal: the question
opened in the session's window, the window did not come to the front, and GNOME showed no notice
that Firefox wanted attention. Nothing told the user that Foxleash was waiting, and the call
returned after 30 s. With the setting off, the question gets only `drawAttention`, which users did
not notice either.

Whether Firefox then reports the refused window as not focused has not yet been measured on that
desktop. In Firefox, `windows.Window.focused` and a page's `document.hasFocus()` come from the
same top-level window activation.

## Decision

**The call that showed a question stops waiting when the question's window is not in front.**
`SessionGroups.windowInFront(windowId)` in `session-groups.ts` reads `windows.get(windowId)` and
answers `focused !== false`; it answers true when Firefox cannot read the window, so only a
definite `false` counts, and a closed question keeps its own close paths.

`show` in `site-access.ts` and `askForSites` in `recipe-prompts.ts`, after `showPromptWindow`
returned and only for a session not stopped or ended and a question still waiting on that call,
arm one check `FRONT_CHECK_MS` (2 s, exported from `site-access.ts`) later, on the window the
question was shown in. The check runs only once the question's page has connected: when the page
has not connected when the 2 s pass, `connect` runs it when it does. After the read it checks
again that the question is still open, that the same call still waits on it and that no answer is
being handled. If the window is not in front, that call is rejected with `approval_timeout` and a
message saying the question's window is not in front, so the user may not have seen it.

The question stays open and unanswered, exactly as after the 30 s timeout. The early end grants
nothing, refuses nothing, closes nothing and charges neither `PROMPT_BUDGET` nor
`RECIPE_PROMPT_BUDGET`. Every place that stops a call's 30 s timer also stops its check: an
answer, a closed or dropped question, the timeout, a stopped or ended session.

A call that joins a question already open (`join` in both files) gets no check: it keeps
`drawAttention` and the full 30 s. The agent was already told where the question is. The propose
page has no waiting call and gets no check.

## Alternatives rejected

- **A desktop notification.** It needs the `notifications` permission, which is a listing change
  and a separate decision. It is the next step if this is not enough.
- **The page's `document.hasFocus()` sent over the port.** It reads the same window activation as
  `windows.get().focused`, and needs a new message in every question page.
- **An early end for joins too.** An agent calling again at once would loop quickly, and
  `foxleash probe` retries `approval_timeout` up to 25 times in 10 minutes: an early end on every
  retry would use up its attempts in about a minute. The probe's retry reloads the question's tab,
  which joins.
- **A new error code.** Agents and the probe already read `approval_timeout` as "the question is
  still open, the user may answer, call again".

## Consequences

- A desktop where Firefox reports a refused window as focused keeps today's 30 s wait.
- There is one check: a window that comes to the front within 2 s and then goes behind is not
  noticed.
- The check reads the window the question was shown in, so a question tab the user dragged to
  another window within 2 s may end the wait early though the user saw it, which costs one extra
  call.
- On the most common path (the setting off, a terminal in front), every new question now ends the
  call at about 2 s. A user who allows the site before the agent calls again is told in the
  question's tab to ask the agent to try again, instead of the page loading there (`settle` loads
  it in that tab only for a call still waiting), and the agent's repeated `tab_open` opens the
  site in a new tab, leaving the answered question's tab behind, as after a 30 s timeout today,
  only more often.
