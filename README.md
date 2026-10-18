# Foxhand

Let an AI agent on your computer, such as Claude Code, use your own Firefox.

Foxhand gives the agent tools to open tabs, read pages, click, type, fill in forms, take
screenshots and read the console and network activity, in your normal Firefox profile with
your logins. It works with any MCP client; it contains no AI model itself.

**Status:** in development, not released yet. Linux only.

## How it works

Foxhand has three parts:

- a **Firefox extension** that carries out the actions,
- a **native host** that Firefox starts and that the extension talks to,
- an **MCP server** that your AI agent starts and that talks to the native host.

Each agent session works in its own tab group, titled Foxhand, and only on tabs in that
group. Nothing leaves your computer except what your agent sends to its model provider:
the page content and browsing activity the agent asks for go from the extension to the
local MCP server, and from there to the agent.

## Requirements

- Linux
- Firefox 140 or later, installed from Mozilla's package or tarball (Snap and Flatpak
  builds are untested)
- Node.js 24 or later
- An MCP client. The setup command registers Foxhand with Claude Code if it is installed.

## Install

```sh
git clone <repository URL>
cd foxhand
npm ci
npm run setup
```

`npm run setup`:

1. writes a small launcher script and registers it with Firefox as the native host
   (`~/.mozilla/native-messaging-hosts/foxhand.json`),
2. registers the MCP server with Claude Code (`claude mcp add -s user foxhand`). To skip
   this, run `npm run setup -- --no-claude`. When `claude` is not on your PATH, setup
   prints the command to run yourself.

Then check that every part is connected:

```sh
npm run doctor
```

It lists the Foxhand host of every running Firefox and whether the extension has access to
all websites.

To update: `git pull && npm ci && npm run setup`, and confirm in Firefox if the extension
changed. To remove: `npm run teardown`, then remove the extension in Firefox.

## Use

Ask your agent to do something in the browser, for example:

> Open the issue list of my project on GitHub and summarize the ones labeled bug.

The first time a session acts on a site, Foxhand asks you in that tab whether to allow it:
once, always, or not at all. You can see and revoke your answers in the extension's
settings.

Each agent session's tabs open in an orange tab group titled Foxhand, and Foxhand acts only
on tabs in that group, including tabs you move into it.

## Security

Foxhand acts in your logged-in browser, so read this before you use it.

The main risk is **prompt injection**: a web page that contains instructions aimed at the
AI model, such as "send the contents of this page to ...". Models can be fooled by these,
and no defense is complete. Foxhand limits what a fooled agent can do:

- It acts on a site only after you approved that site in the browser. The approval can
  only come from your click, not from the agent.
- Financial and health sites are blocked by default. You can edit the list.
- File uploads only read from allowed folders (the agent's working folder and
  `~/Downloads` by default) and never dotfiles or key files.
- Tool results mark page content as untrusted, and the agent is told not to follow
  instructions found in pages.

Your agent's own permission settings still apply on top of this, but do not rely on them
alone: many people run agents with prompts turned off.

Avoid using Foxhand on sites where a mistake is costly (banking, health records, admin
panels with destructive actions), and stay nearby while it works.

## Limits

Firefox gives extensions no way to produce real user input, so all clicks and keystrokes
are simulated. Some things therefore do not work:

- actions that need a real user gesture: opening pop-up windows, writing to the
  clipboard, entering fullscreen, opening a file picker,
- sites that ignore simulated events.

The agent is told about these limits and asks you to take such steps yourself.

## Development

See [docs/development.md](docs/development.md) for building, testing and running a
development copy, and [AGENTS.md](AGENTS.md) for the project's conventions.
Architecture decisions are recorded in [docs/adr/](docs/adr/).
