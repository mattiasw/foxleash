# 0005: MCP is the model boundary: no LLM in v1

**Status:** Accepted, 2026-10-17.

## Context

Foxleash gives a model tools; it does not bring a model. The model lives in the MCP client
the user already runs. Any MCP client should be able to use Foxleash unchanged: Claude
Code, Codex, Gemini CLI, opencode or another one.

In this record, v1 means Foxleash's current feature set. The decision holds until a later
record supersedes it.

## Decision

v1 contains no LLM, makes no model API calls and holds no API keys. Neither the extension
nor the server talks to a model provider.

Tool names are neutral and are the MCP contract. Tool descriptions and the server's MCP
instructions avoid wording specific to one client and are written for any agent.

A possible v2 adds a chat in a Firefox sidebar. If it comes, it goes through a small
`AgentBridge` interface in the host: send a message, receive a reply or a status. The
first implementation would use Claude Code channels. Channels are a research preview,
behind hidden flags, may change, and need a claude.ai or Console login. The interface
keeps the chat independent of them.

None of this is built now. This record exists so that v1 code does not rule it out.

## Alternatives rejected

- **A model or API key inside the extension.** The key would need protecting, every
  request would cost the user money, and page data would go to a model provider. It would
  also change what data leaves the browser, which is a listing change.
- **Client-specific tool names or wording.** Naming tools or writing descriptions for one
  client locks the others out, or leaves them with instructions that do not fit.
- **Building the chat directly on channels, with no interface.** Channels are a research
  preview that may change. Code written straight against them would have to change with
  them, and would tie the chat to one client.

## Consequences

There is no chat in v1. Users need an MCP client to use Foxleash at all.

v1 code must not assume a single client or a single session. Several clients can connect
at once, each with its own session, and nothing in the host may depend on one of them
being the only one.
