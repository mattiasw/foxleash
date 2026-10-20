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
- The GitHub CLI (`gh`), logged in (`gh auth login`) with an account that can read this
  repository's releases, unless you install from a signed `.xpi` with `--xpi`.

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
3. downloads the signed extension for this checkout's version from the repository's GitHub
   releases into `~/.cache/foxhand/` and opens it in Firefox, where you confirm the
   installation. To install from a signed `.xpi` you already have, run
   `npm run setup -- --xpi <path>`; to skip this step, run
   `npm run setup -- --no-extension`. When `firefox` is not on your PATH, setup prints the
   file to open in Firefox yourself.

Then check that every part is connected:

```sh
npm run doctor
```

It lists the Foxhand host of every running Firefox and whether the extension has access to
all websites.

To update: `git pull && npm ci && npm run setup`, then confirm the installation in
Firefox. To remove: `npm run teardown`, then remove the extension in Firefox.

## Use

Ask your agent to do something in the browser, for example:

> Open the issue list of my project on GitHub and summarize the ones labeled bug.

Before a session opens a page on a site you have not approved, Foxhand asks you in that tab
whether to allow it: this session, always, or not at all. The agent's call waits up to 30
seconds for your answer. After three refused or closed prompts, a session stops asking.

The extension's settings page in the Firefox add-ons manager lists the sites you allowed
always, each with a Revoke button. It also lists the sites you allowed or refused for each
running agent session, and the prompts you closed without an answer, each with a Forget
button: forgetting an answer makes Foxhand ask again. Foxhand keeps these session answers only
in memory until the session ends. The settings page is also where you edit the blocklist.

For a tab on a site you have not approved, the agent sees only the site's address (scheme,
host and port), with no path, query or title. A local file shows only as `file:`.

Each agent session's tabs open in an orange tab group titled Foxhand, and Foxhand acts only
on tabs in that group, including tabs you move into it. When the agent session ends, Foxhand
closes its group if the group holds only blank tabs, so pages you may still be reading stay
open.

The Foxhand button in the toolbar shows ON on the tabs an agent session can use; clicking it
opens Foxhand's settings.

The agent reads a page with `read_page`, which returns the page as an accessibility tree: one
line per element with its role, name and state (such as checked, disabled, a field's value or
a link's address), and the page's visible text. Each element line carries an element
reference that later tools use to act on that element; references are valid only for the page
they came from. Hidden elements are left out, and frames are noted but not read. The agent
can read only the interactive elements (`filter: "interactive"`), fewer levels (`depth`) or one
element and what it contains (`ref`). The tree is cut at 50,000 characters, and the agent is
told when it was. `read_page` works only on a tab showing a site you approved, and never asks.

The agent reads a page's text with `get_page_text`: the text as the page shows it, the main
content first (the page's main element or article, else its largest block of text), then the
rest of the page. Text hidden with display, visibility or the hidden attribute and the values
of form fields are left out, and frames are not read. The text is cut at 50,000 characters
unless the agent asks for more (at most 200,000), and the agent is told when it was.
`get_page_text` works only on a tab showing a site you approved, and never asks.

## Security

Foxhand acts in your logged-in browser, so read this before you use it.

The main risk is **prompt injection**: a web page that contains instructions aimed at the
AI model, such as "send the contents of this page to ...". Models can be fooled by these,
and no defense is complete. Foxhand limits what a fooled agent can do:

- It acts on a site only after you approved that site in the browser, and asks before it
  opens a page there. The approval can only come from your click, not from the agent. Two
  ways still reach a site you have not approved without asking: going back or forward in a
  tab's history, and a page on an approved site that redirects to another site. The agent
  then sees only that site's address.
- Tabs on sites you have not approved show the agent only the site's address, with no path,
  query or title, and a local file only as `file:`. The sites you allowed always are listed
  in the extension's settings page in the add-ons manager, each with a Revoke button.
- Financial and health sites are blocked by default. You can edit the list in the
  extension's settings page, one domain per line. Foxhand checks the blocklist before it
  opens or reloads a page, and shows the agent a tab on a blocked site only as the site's
  address.
- File uploads only read from allowed folders (the agent's working folder and
  `~/Downloads` by default) and never dotfiles or key files.
- Tool results mark page content as untrusted, and the agent is told not to follow
  instructions found in pages.
- The values of password, one-time code and card number fields are never returned to the
  agent, only whether they are filled: Firefox fills saved passwords into login pages when
  they load, and a page you approved could otherwise hand yours to the agent.

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
