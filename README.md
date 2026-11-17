# Foxleash

Let an AI agent on your computer, such as Claude Code, use your own Firefox.

Foxleash gives the agent tools to open tabs, read pages, click, type, fill in forms, take
screenshots and read the console and network activity, in your normal Firefox profile with
your logins. It works with any MCP client; it contains no AI model itself.

**Status:** in development, not released yet. Linux only.

## How it works

Foxleash has three parts:

- a **Firefox extension** that carries out the actions,
- a **native host** that Firefox starts and that the extension talks to,
- an **MCP server** that your AI agent starts and that talks to the native host.

Nothing leaves your computer except what your agent sends to its model provider: the page
content and browsing activity the agent asks for go from the extension to the local MCP
server, and from there to the agent.

## Requirements

- Linux
- Firefox 142 or later, installed from Mozilla's package or tarball (Snap and Flatpak
  builds are untested)
- Node.js 24 or later
- An MCP client. The setup command registers Foxleash with Claude Code if it is installed.
- The GitHub CLI (`gh`), logged in (`gh auth login`) with an account that can read this
  repository's releases, unless you install from a signed `.xpi` with `--xpi`.

## Install

```sh
git clone <repository URL>
cd foxleash
npm ci
npm run setup
```

`npm run setup` does three things:

1. It writes a small launcher script and registers it with Firefox as the native host
   (`~/.mozilla/native-messaging-hosts/foxleash.json`).
2. It registers the MCP server with Claude Code (`claude mcp add -s user foxleash`).
3. It downloads the signed extension for this checkout's version from the repository's GitHub
   releases into `~/.cache/foxleash/` and opens it in Firefox, where you confirm the
   installation.

| Option | What it does |
|---|---|
| `npm run setup -- --no-claude` | Skips step 2. |
| `npm run setup -- --xpi <path>` | Installs a signed `.xpi` you already have instead of downloading one. |
| `npm run setup -- --no-extension` | Skips step 3. |

When `claude` is not on your PATH, setup prints the command to run yourself; when `firefox` is
not, it prints the file to open in Firefox. For another MCP client, register the command
`node <path to this checkout>/apps/server/src/main.ts mcp` as a stdio server.

Once the extension is installed, Firefox opens a Foxleash page that shows whether the program on
this computer is connected; the settings page shows the same. Both pages also say when the program
is too old for the add-on, or newer than it, and what to do.

Then check that every part is connected:

```sh
npm run doctor
```

It lists the Foxleash host of every running Firefox and whether the extension has access to
all websites.

- **Update:** `git pull && npm ci && npm run setup`, then confirm the installation in Firefox.
- **Remove:** `npm run teardown`, then remove the extension in Firefox.

## Use

Ask your agent to do something in the browser, for example:

> Open the issue list of my project on GitHub and summarize the ones labeled bug.

### Approving sites

Before the agent opens a page on a site you have not approved, Foxleash asks you in that tab
whether to allow it: this session, always, or not at all. The agent's call waits up to 30
seconds for your answer. After three refused or closed prompts, a session stops asking.

At the start of a task, the agent can also ask you on one page to allow the sites the task
needs, for that session only.

### The agent's tabs

Each agent session's tabs open in an orange tab group titled Foxleash, and Foxleash acts only on
tabs in that group, including tabs you move into it and tabs that a page in the group opens.
When the session ends, Foxleash closes its group if the group holds only blank tabs, so pages
you may still be reading stay open. Subagents started from one agent session share its tab
group and the sites you approved for it.

The Foxleash button in the toolbar shows ON on the tabs an agent session can use, and ! on tabs
outside an agent session's group when the program is too old for the add-on or newer than it;
clicking it opens Foxleash's settings.

### Settings

The extension's settings page, in the Firefox add-ons manager, has:

- the state of the Foxleash program on this computer: connected, not found, with the command
  that installs it, or too old for the add-on or newer than it, with what to do,
- the sites you allowed always, each with a Revoke button,
- each running agent session, numbered in the order it started, with a Stop this session
  button, and the sites you allowed or refused for it and the prompts you closed without an
  answer, each with a Forget button, which makes Foxleash ask again (Foxleash keeps these answers
  only in memory until the session ends),
- the blocklist, one domain per line,
- your recipes, which you write, edit and delete there,
- the setting "Open each agent session in its own window", off by default. When it is on, a
  session's tabs open in a new window beside yours, so the tab selected in your window stays as
  it is.

### Recipes

A recipe is a task's steps written down with the sites it uses, kept in Firefox on this
computer. You write one in the settings page, or the agent proposes one, which you read, edit
and save in Firefox. Later agent sessions read a saved recipe as your instructions, so read it
before you save it.

An agent can read your saved recipes and ask you to allow a recipe's sites for its session in
one click. To start a saved recipe from Claude Code, run `/mcp__foxleash__run_recipe <name>`; a
part of the name that only one recipe has is enough.

### What the agent can do

| Tools | What the agent does with them |
|---|---|
| `tabs_list`, `tab_open`, `tab_select`, `tab_close`, `navigate`, `resize_window` | Lists, opens, selects and closes the tabs in its group, loads and reloads pages in them, goes back and forward, and resizes the window. |
| `read_page`, `get_page_text` | Reads a page as a tree of its elements, each with a reference the other tools act on, or as text. |
| `screenshot` | Takes a PNG of what a tab shows or of one element, and can save it in the agent's working folder. |
| `read_console`, `read_network` | Reads what a page wrote to its console, and its network requests, which it can filter by URL text, resource type and failure, with their headers, the field names of what each sent but never the values, or the text of fetch responses from approved sites, when it asks. |
| `click`, `hover`, `scroll`, `drag` | Uses the pointer on an element or at a point. |
| `type`, `fill_form`, `press_key` | Types text, fills in several form fields in one call, and presses keys. |
| `wait_for` | Waits for text, an element or a navigation. |
| `batch` | Runs up to 20 tool calls in one call. |
| `upload_file`, `download` | Uploads files from allowed folders, and saves a file from a site you approved in your Firefox download folder. |
| `propose_recipe`, `list_recipes`, `get_recipe`, `start_recipe` | Proposes a recipe for you to save, reads your saved recipes, and asks you to allow a recipe's sites. |
| `request_sites` | Asks you on one page to allow the sites a task needs. |

[docs/tools.md](docs/tools.md) describes each tool with its limits and timings.

### Claude Code permissions

Claude Code asks for permission before each Foxleash call unless `"mcp__foxleash"` is listed
under `permissions.allow` in your Claude Code settings. Foxleash still asks in Firefox before
it opens a site you have not approved, but uploads from the upload folders then happen without
a prompt. [docs/claude-code.md](docs/claude-code.md) says how to keep that prompt, and lists
other settings that make browser tasks faster.

## Security

Foxleash acts in your logged-in browser, so read this before you use it.

The main risk is **prompt injection**: a web page that contains instructions aimed at the AI
model, such as "send the contents of this page to ...". Models can be fooled by these, and no
defense is complete. Foxleash limits what a fooled agent can do:

- It acts on a site only after you approved that site in the browser. The approval can only
  come from your click, not from the agent. Content that site's pages embed from other sites,
  blocklisted ones included, can show up in what the agent reads, such as a screenshot.
- The settings list each running agent session with a Stop this session button: after your
  click Foxleash refuses every tool call of that session, also on sites you allowed always. A
  new agent session is not stopped, and an agent that can run programs on your computer can
  start one itself.
- It refuses clicks on links and form buttons that lead to another site or out of the browser.
- Tabs on sites you have not approved show the agent only the site's address, with no path,
  query or title.
- A built-in list of common financial and health sites is blocked by default. The list is
  short and names mostly sites in the United States, the Nordic countries and the United
  Kingdom: a site that is not on it, such as a regional care provider, is not blocked until you
  add it to the list in the settings. Proposals for more sites are welcome, as an issue or as a
  pull request that edits [the built-in list](apps/extension/src/default-blocklist.ts).
- File uploads only read from [allowed folders](docs/security.md#uploads) (the agent's working
  folder and `~/Downloads` by default) and never dotfiles or key files.
- Downloads save only a file served by a site you approved, into your Firefox download folder,
  never over an existing file. The file is saved as the site sent it, with nothing hidden or
  redacted. The agent reads a downloaded file with its own tools, outside Foxleash's untrusted
  marking.
- A recipe is saved, and a recipe's or a task's sites are allowed, only by your click on a
  Foxleash page in Firefox. Sites allowed this way are allowed for the session only.
- Text results and screenshots hide the values of password fields, of one-time code and card
  number fields that the page marks as such for autofill, and of text fields that Firefox
  filled in from your saved logins, addresses or cards, until you edit them. This has
  [exceptions](docs/security.md#protected-fields).
- Tool results mark page content as untrusted, and the agent is told not to follow
  instructions found in pages.

Ways that still reach a site you have not approved without asking include: going back or forward in
a tab's history; a page on an approved site that redirects or, with its own scripts, sends the tab
to another site; a page on an approved site that loads an address on another site that the agent
gave it, for example as an image; and a download from an approved site that redirects to another
site. In the first two, the agent then sees only that site's address. When an address the agent
opens or downloads answers with a redirect to another site, Firefox sends that site all your cookies
for it, including those that a link from another site would not carry. Asking before opening a site
you have not approved and refusing clicks that lead to another site cover where the tab goes: they
make it harder to send what the agent read to another site, not impossible.

[docs/security.md](docs/security.md) describes each safeguard in full, with its exceptions.

Your agent's own permission settings still apply on top of this, but do not rely on them
alone: many people run agents with prompts turned off.

An agent that can run programs on your computer, for example through a shell tool with its
prompts turned off, can also connect to Foxleash's native host itself. It then gets a new
session that can use every site you allowed always, and the upload rules, the saved screenshots
folder and the untrusted marking do not apply to it. Site approval, the blocklist, the hiding of
other sites' tabs, protected fields, the click refusals and the download rules still hold for
what it sends through Foxleash; [docs/security.md](docs/security.md#the-risk) says where they
end and how to cut such an agent off.

Avoid using Foxleash on sites where a mistake is costly (banking, health records, admin
panels with destructive actions), and stay nearby while it works.

## Limits

Firefox gives extensions no way to produce real user input, so all clicks and keystrokes
are simulated. Some things therefore do not work:

- actions that need a real user gesture: opening pop-up windows and new tabs (unless you
  allow pop-ups for the site), writing to the clipboard, entering fullscreen, opening a file
  picker,
- sites that ignore simulated events.

The agent is told about these limits and asks you to take such steps yourself.

## The name

The agent works in your Firefox on a leash that you hold. A leash is also an old collective
noun for foxes: a leash of foxes.

## More documentation

- [docs/tools.md](docs/tools.md): each tool, with its limits and timings
- [docs/security.md](docs/security.md): each safeguard in full, with its exceptions
- [docs/claude-code.md](docs/claude-code.md): Claude Code settings that make browser tasks
  faster
- [docs/development.md](docs/development.md): building, testing and running a development copy
- [AGENTS.md](AGENTS.md): the project's conventions
- [docs/adr/](docs/adr/): architecture decisions
