# Faster tasks in Claude Code

In a timed test, most of a browser task's time went to model requests, not to Foxleash. These
Claude Code settings can shorten it; how much depends on the task.

## Allow Foxleash's tools

Claude Code asks for permission before each Foxleash call unless `"mcp__foxleash"` is listed
under `permissions.allow` in your Claude Code settings (see the
[permissions documentation](https://code.claude.com/docs/en/permissions)). Foxleash does not set
these rules, so you add them yourself.

- Foxleash's own approval still applies: a session still asks in Firefox before it opens a site
  you have not approved.
- Uploads from the upload folders then happen without a prompt; to keep one, also list
  `"mcp__foxleash__upload_file"` and `"mcp__foxleash__batch"` under `permissions.ask`.
- A rule that denies or asks for one tool does not cover that tool inside `batch`, which can
  run every Foxleash tool: deny or ask for `batch` too to keep it.

## A lower effort level

In a timed shopping task on a local test page (search, pick a product, fill a checkout form),
`claude --effort low` finished in 22.7 s with Opus 5.5, against 26.9 and 27.0 s without it (a
third run took 38.7 s, 21.9 s of it in tool calls), and in 24.3 s with Sonnet 5.5, against 27.8
and 29.3 s. Each low effort figure is one run.

## Fast mode

Anthropic documents up to 2.5 times the output speed at twice the per-token price, for the
models that offer it (see the
[fast mode documentation](https://code.claude.com/docs/en/fast-mode)). On a subscription plan it
is paid from usage credits, not from the plan's included usage. It was not measured with
Foxleash.

## The model

In the same test every model tried took 1.2 to 2.2 s per model request, and the smallest model
was not the fastest.
