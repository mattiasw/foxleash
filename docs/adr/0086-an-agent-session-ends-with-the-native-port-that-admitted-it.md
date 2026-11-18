# 0086: An agent session ends with the native port that admitted it

**Status:** Accepted, 2026-11-18.

## Context

A session counts as running, listed on the settings page and shown as ON on its group's tabs,
from its first request until the extension ends it. The extension ended a session only when the
native host sent `session_end`, and the host sends one only while it is open: a host that exits,
crashes or is replaced by the extension's re-check of a program that is too old sends none. The
sessions it served stayed running until Firefox restarted.

The extension cannot tell from its side whether the MCP bridge behind a session is still alive.
A bridge whose host went away connects again lazily, with the same session id, to the next host,
and with several Firefox instances that host may belong to another Firefox, so the first one
would never hear of the session again.

## Decision

A session runs only while the native port that admitted it is open.

- `connection.ts` keeps, per port, the sessions whose requests it passed to `handleRequest`
  (`admitted`, a `WeakMap<Port, Set<string>>` beside `verdicts`). A session is recorded before
  its request is handled, after the refusals for a port with no welcome or with a host the
  extension does not serve, so a request still running when the port goes away is covered and
  a refused request records nothing.
- When that port disconnects, or `recheck()` replaces it, `endAdmitted` ends each recorded
  session through the same `endSession` a `session_end` calls, in the order first seen. A failure
  to end one session, whether a rejection or a synchronous throw, is logged and does not stop
  the others, the state change or the reconnect.
- A `session_end` removes its session from the port's record, so the port's later loss does not
  end it a second time. A later request of the same session on that port records it again.
- A request that arrives on a port that is no longer the current one is not handled: nothing
  would end a session recorded there, and its answer could not be delivered.
- A session that sends again over the next port is admitted as a new run of the same id: it
  keeps its tab group and a stop (ADR 0069), and is asked again for sites approved only for the
  session.

## Alternatives rejected

- Keeping sessions across a host restart so that session approvals survive it: a session whose
  program exited stays listed and shows ON until Firefox restarts, which is the defect.
- A grace timer before ending: ON and the settings row stay wrong for its length, for more state.
- Having the host report its live sessions after a reconnect: a protocol change across both
  release lines, and a crashed host has nothing to report.

## Consequences

- An agent that outlives a host restart or crash goes on as the same session, still stopped if
  the user stopped it, but its answers are forgotten, as after a `session_end`: it is asked again
  for the sites allowed only for it, may ask again about sites the user refused, and has three new
  refused or closed prompts. Its group closes if it holds only blank tabs.
- Its recordings, page views, staged uploads and recipe pages end with it, so such an agent
  starts those again. The settings page lists it again with a new number.
- A host that hangs with its port open keeps its sessions running: nothing ends a session while
  its port is open.
- This replaces ADR 0069's consequence that a session whose program went away without telling the
  extension stays listed as running until the background page restarts.
