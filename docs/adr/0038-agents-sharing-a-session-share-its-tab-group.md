# 0038: Agents sharing a session share its tab group

**Status:** Accepted, 2026-11-06.

## Context

In a field test, four Claude Code forks running in parallel in one session all got the same
Foxhand tab group. `tabs_list` and `tab_close` results listed every fork's tabs, any fork could
act on another fork's tab by id, and a fork's tab turned `"active": false` as soon as another
fork opened a tab in the same window.

A session is one `foxhand mcp` process: `apps/server/src/mcp.ts` creates one `randomUUID()`
session per process, the bridge stamps it on every request, and `apps/server/src/host.ts` binds
a connection to one session. An MCP tool call carries no caller identity, so agents that share
one MCP connection are one session to Foxhand. That subagents and forks of Claude Code share
their parent's MCP connection is from the field test and Claude Code's behaviour, not
reproduced here. `active` is Firefox's `tab.active`, the active tab of the tab's window, so it
changes whenever any tab in the window is opened or selected.

Site approvals are per session
([0007](0007-per-site-approval-and-tab-redaction.md)) and must stay shared across it: a fork
must never get a new approval prompt for a site the session already has.

## Decision

Tabs are shared across a session, and so are its approvals. Each agent keeps track of the tabs
it works with (the tabs it opened, the tabs its own actions opened and the tabs the user points
it to) and leaves other tabs in the group alone. The server instructions
(`apps/server/src/instructions.ts`), the `tabs_list` description (`apps/server/src/tools.ts`)
and the README say so, and say that `active` means the active tab of the tab's window. Nothing
changes in tab handling, the protocol or the extension.

## Alternatives rejected

- An optional owner label on `tab_open`, checked by every tool that takes a tab id. The agent
  asserts the label itself, so it is a convenience and not a safeguard against a page's injected
  instructions, and it adds a parameter to every tab-taking tool and per-tab state to the
  extension, for the same discipline as tracking ids.
- A nested tab group per agent. Firefox tab groups do not nest, and Foxhand still could not tell
  which agent a call comes from.

## Consequences

- A wrong tab id from one agent can disrupt another agent's tab: close it, navigate it or take
  its focus. No safeguard in the Security section of AGENTS.md depends on tab ownership between
  agents of one session; they all hold the same site approvals.
- The agents also share the session's prompt budget
  ([0007](0007-per-site-approval-and-tab-redaction.md)) and its recipe page: one open prompt or
  recipe page at a time, and once three prompts were refused or closed unanswered, no agent of
  the session gets another. A `tab_open` on the site being asked about can return the tab
  that asks, so two agents can end up in one tab; the server instructions tell an agent refused
  because of another agent's question to retry its own call instead of reloading that tab.
- Revisit this if MCP clients start sending a per-agent identity with tool calls: tabs could
  then belong to the agent that opened them.
