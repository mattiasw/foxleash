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
- Firefox 142 or later, installed from Mozilla's package or tarball (Snap and Flatpak
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
in memory until the session ends. The settings page is also where you edit the blocklist,
and where you write, edit and delete recipes: a task's steps written down with the sites it
uses, kept in Firefox on this computer. An agent can also read the recipes you saved, and
propose a recipe, which you read and save in Firefox.

For a tab on a site you have not approved, the agent sees only the site's address (scheme,
host and port), with no path, query or title. A local file shows only as `file:`.

Each agent session's tabs open in an orange tab group titled Foxhand, and Foxhand acts only
on tabs in that group, including tabs you move into it and tabs that a page in the group
opens, also after your own click. When the agent session ends, Foxhand closes its group if the
group holds only blank tabs, so pages you may still be reading stay open.

The agent can switch to (`tab_select`) and close (`tab_close`) only tabs in its own group, and
never closes the last tab of a window. When a tab's page asks you to confirm leaving it,
`tab_close` tells the agent so, and Firefox closes the tab once you choose to leave the page.
`resize_window` resizes the whole window that holds the agent's group, your own tabs in it
included, and first returns a maximized, minimized or full-screen window to its normal state.

The Foxhand button in the toolbar shows ON on the tabs an agent session can use; clicking it
opens Foxhand's settings.

The agent reads a page with `read_page`, which returns the page as an accessibility tree: one
line per element with its role, name and state (such as checked, disabled, the value of a field
or an editable area, or a link's address), and the page's visible text. Each element line
carries an element reference that later tools use to act on that element; references are valid
only for the page they came from. A file field's line is marked `file field`, so the agent can
find it for `upload_file` even when the page gives it no label. Hidden elements are left out,
and frames are noted but not read. The agent can read only the interactive elements
(`filter: "interactive"`), fewer levels (`depth`) or one element and what it contains (`ref`).
The tree is cut at 50,000 characters, and the agent is told when it was. `read_page` works
only on a tab showing a site you approved, and never asks.

The agent reads a page's text with `get_page_text`: the text as the page shows it, the main
content first (the page's main element or article, else its largest block of text), then the
rest of the page. Text hidden with display, visibility or the hidden attribute and the values
of form fields are left out, and frames are not read. The text is cut at 50,000 characters
unless the agent asks for more (at most 200,000), and the agent is told when it was.
`get_page_text` works only on a tab showing a site you approved, and never asks.

The agent reads what a page wrote to its console with `read_console`: its `console.log`,
`info`, `warn`, `error` and `debug` calls, uncaught errors and unhandled promise rejections,
oldest first, each with its level, kind, text and time. Foxhand starts recording a page shortly
after it starts loading, in a tab of the agent's group on a site you approved, so anything the
page logs before then is missed. A page that loads quickly, such as a small page served from
your own computer, can finish loading first, so what it logs while it loads, in its `load`
event included, can be missed; what it logs once recording has started is recorded. Frames are
not recorded. Loading a new page in the tab starts with no messages. Foxhand keeps the newest
300 messages of a page, each cut to 1,000 characters, and counts the older ones it let go. The
agent can ask for messages of a minimum level, those whose text matches a regular expression,
and at most a number of the newest ones (100 unless it asks for up to 300). When the page
loaded before you approved the site, or since it loaded you withdrew the approval or the tab
left the agent's group, the result says it is not recording, with no messages, until the page
is loaded again. `read_console` works only on a tab showing a site you approved, and never
asks.

The agent reads a page's network requests with `read_network`: each request's URL, method,
resource type, start time, duration, status, redirect target, error and whether it came from
the cache, with its request and response headers, oldest first. The values of the `Cookie`,
`Set-Cookie`, `Authorization` and `Proxy-Authorization` headers are replaced with
`[redacted]`, and request and response bodies are not included. Requests made by the page's
frames are included. Foxhand records a page's requests from when it starts loading in a tab of
the agent's group on a site you approved, and loading a new page in the tab starts a new list.
Foxhand keeps the newest 500 requests of a page, fewer when their headers are long. The agent
can ask for the requests whose URL contains a piece of plain text, and at most a number of the
newest ones (100 unless it asks for up to 500). When the page loaded before you approved the
site, or since it loaded you withdrew the approval or the tab left the agent's group, the
result says it is not recording, with no requests, until the page is loaded again.
`read_network` works only on a tab showing a site you approved, and never asks.

The agent acts in a page with `click`, `hover`, `scroll` and `drag`, on an element from
`read_page` (scrolled into view first) or at a point in the tab's viewport, as in a
screenshot. They send the pointer and mouse events a real mouse sends, in order: a click is
pointerdown, mousedown, pointerup, mouseup and click, after the pointer moves onto the
element. `scroll` sends a wheel event and then scrolls what that wheel would scroll, or brings
an element into view. `drag` sends HTML drag-and-drop events when the element is draggable,
and otherwise moves the pointer to the end in steps. The events are simulated, so CSS `:hover`
styles do not apply and pages that ignore simulated input do not react. Foxhand refuses an
element that another one covers, naming the covering element, and does not act inside frames.
It refuses clicks on links and form buttons that lead to another site or out of the browser,
such as to an email address: the agent opens a page on another site with `navigate`, which asks
you first. Firefox's pop-up blocker stops a link or form button that opens a new tab unless you
allow pop-ups for the site; a new tab that does open joins the agent's tab group, while a new
window is out of the agent's reach. These tools work only on a tab showing a site you
approved, and never ask.

The agent types text with `type`, into a text field or an editable area from `read_page`.
Foxhand focuses the element, adds the text and reads it back. A text field gets the text after
what it already holds. An editable area gets it at its caret when the caret is in it, and
otherwise at its start, so in an email body the text goes above a signature that is already
there. Text typed in several calls follows on, but once the agent types into another field, the
next text goes at the start of the area again. In an editable area each newline in the text
becomes a line break. In an email body whose first line is empty above the signature, the text
fills that line as yours would, so the agent ends it with a newline to keep a blank line before
the signature. Foxhand sends no key events: it inserts the text the way the browser inserts
typed text, and when that changes nothing and the page did not receive it, once more by setting
the field's value the way a page's own scripts do. When an editor cannot be read back, such as
the body of a Google Docs document, the result says the text was sent but not confirmed. `type`
refuses a field that Firefox filled in from your saved logins, addresses or cards, until you
edit it. It works only on a tab showing a site you approved, and never asks.

The agent fills several form fields in one call with `fill_form`, each given by its reference
from `read_page`: text fields, selects, checkboxes and radio buttons. The text replaces what a
field holds and goes in as with `type`; a select takes the value or label of an option, and a
checkbox or radio button is clicked when its state differs. The result says for each field
whether it was filled or why not, and never contains a field's value. `fill_form` never
submits the form, and refuses a text field that Firefox filled in from your saved logins,
addresses or cards, as `type` does. It works only on a tab showing a site you approved, and
never asks.

The agent presses a key with `press_key`, such as `Enter`, `Tab`, `Shift+Tab`, `Escape`,
`ArrowDown` or `Control+a`, on an element from `read_page` or on the focused element. Foxhand
sends the key's events and then does what the browser would do, unless the page cancels the
key: Enter submits the form or clicks the button or link, Tab and Shift+Tab move focus,
Escape closes an open popover or dialog, and the arrow keys choose an option in a list. Other
keys reach only the page's own key handlers and do not insert or delete text. Enter on a link
or in a form that leads to another site or out of the browser is refused, as clicks are.
Enter on a link or in a form that opens a new tab meets the pop-up blocker, as clicks do.
`press_key` works only on a tab showing a site you approved, and never asks.

The agent runs several tool calls in one call with `batch`, up to 20, one after the other in
order, with arguments it already has: a step cannot use what an earlier step returns. It stops
at the first step that fails, a `fill_form` with a field that was not filled included, and says
which steps did not run. Each step is checked exactly as when its tool is called on its own: a
step that reads or acts in a page on a site you have not approved fails, and a `tab_open` or
`navigate` step asks you first. An MCP client that asks you before each tool call asks once for
the whole batch, and a rule in your client that denies or asks for one tool does not cover that
tool inside `batch`: deny or ask for `batch` too to keep it. Foxhand's own checks apply to
every step.

The agent takes a PNG screenshot with `screenshot`: of the part of the page a tab shows, also
when the tab is in the background, or with `ref` of one element from `read_page`. For an
element screenshot Foxhand scrolls the page to bring the element into view, then captures its
box, cut to the part inside the window. With `saveTo`, Foxhand also saves the PNG as a new file
in the folder `foxhand mcp` was started in, normally the agent's working folder: the path must
be inside that folder, end in `.png` and be in a folder that exists, with no folder or file
name starting with a dot, and an existing file is never replaced. Saved files are readable
only by you (mode 0600). A screenshot larger than about 6 MB is too large to return; the agent
can then take one of a single element or save it. Screenshots hide the text of password fields,
of one-time code and card number fields that the page marks as such for autofill, and of text
fields that Firefox filled in from your saved logins, addresses or cards, until you edit them
(see Security). When a frame of the page loads while the screenshot is taken, Foxhand refuses
it and the agent can try again. A page Foxhand cannot get into, such as a PDF shown in Firefox's
viewer, cannot be captured, and neither can a page with such a PDF in a frame or with a frame
that never finishes loading. A frame showing Firefox's error page for a page that could not be
loaded or does not allow being shown in a frame does not stop a screenshot, but one showing a
certificate error or a blocked-site warning does. A frame of another add-on, such as a
password manager's menu, does not stop a screenshot either: Foxhand hides it and every other
frame of the same page or frame, which show blank in the screenshot. `screenshot` works only on
a tab showing a site you approved, and never asks.

The agent uploads files from your computer with `upload_file`, naming the files and an element
from `read_page`. A file field gets the files as if you had picked them; any other element gets
them dropped on it, which works only where the page takes dropped files. Foxhand reads files
only from the upload folders (see Security below), never files or folders whose names start
with a dot or files named like keys, and at most 100 files and 10 MB per upload. `upload_file`
works only on a tab showing a site you approved, and never asks.

The agent saves a file from the web with `download`, giving its URL (such as a link's address
from `read_page`) and a plain file name such as `receipt.pdf`. Foxhand fetches the file with
your cookies for the site, as following the link would, saves it in your Firefox download
folder and returns its absolute path and size; the agent can move it from there. The file is
saved even where Firefox would open it in another application, such as a PDF set to open in a
PDF viewer. The URL, and the address the file comes from after any redirects, must be on sites
you approved, and `download` never asks. The name must not contain a slash or backslash, control
or formatting characters, or start with a dot, and Firefox refuses some others, such as names
ending in `.desktop`; Firefox adds a number when the name is taken, so an existing file is never
replaced. At most 100 MiB and 50 seconds per file, one download at a time. Each download shows
in Firefox's downloads panel and history.

The agent proposes a recipe with `propose_recipe`, giving its name, description, sites and
steps. Foxhand opens a page in the session's tab group that shows them in fields you can edit,
and saves the recipe only when you click Save there; Discard drops it. When you have a recipe
with that name, the page shows your saved version and the changes to its steps. The call
returns at once with the page's tab id and does not tell the agent whether you saved. While
the page is open, the session cannot open another recipe page or ask you about a site, and
cannot close the page's tab or load another page in it. After three recipe pages that you
discarded or closed, Foxhand opens no more in that session. A page still open when the session
ends stays open and can still save.

The agent reads your saved recipes with `list_recipes`, which gives each one's name,
description, sites and the time you saved it, sorted by name, without the steps, and with
`get_recipe`, which gives one recipe with its steps by its name. Foxhand hands the agent a
recipe as your instructions, outside the untrusted marking it puts on page content; what the
agent reads on pages while following a recipe is still marked untrusted.

The agent waits with `wait_for` until a page shows some text, until an element matching a CSS
selector exists in it, or until the next navigation in a tab finishes: 10 seconds unless it
asks for up to 30. Text is matched in the text the page shows, without the values of form
fields. A selector that contains `[` together with `value` or `ng-reflect` is refused, since it
could test what a password field holds, which Angular development builds can copy into
`ng-reflect` attributes. A page that changes its address with its own scripts
(`history.pushState` or `replaceState`) counts as a navigation. Waiting for text or a selector
works only on a tab showing a site you approved, and never asks.

## Security

Foxhand acts in your logged-in browser, so read this before you use it.

The main risk is **prompt injection**: a web page that contains instructions aimed at the
AI model, such as "send the contents of this page to ...". Models can be fooled by these,
and no defense is complete. Foxhand limits what a fooled agent can do:

- It acts on a site only after you approved that site in the browser, and asks before it
  opens a page there. The approval can only come from your click, not from the agent. It
  refuses clicks on links and form buttons that lead to another site or out of the browser,
  such as to an email address, and Enter pressed on such a link or in such a form; the agent
  opens a page on another site with `navigate`, which asks first. Two ways still reach a site
  you have not approved without asking: going back or forward in a tab's history, and a page
  on an approved site that redirects or, with its own scripts, sends the tab to another site,
  for example after a click. The agent then sees only that site's address. A page's own
  scripts can also open an email address.
- Tabs on sites you have not approved show the agent only the site's address, with no path,
  query or title, and a local file only as `file:`. The sites you allowed always are listed
  in the extension's settings page in the add-ons manager, each with a Revoke button.
- Financial and health sites are blocked by default. You can edit the list in the
  extension's settings page, one domain per line. Foxhand checks the blocklist before it
  opens or reloads a page, and shows the agent a tab on a blocked site only as the site's
  address.
- File uploads only read from allowed folders (the agent's working folder and
  `~/Downloads` by default) and never dotfiles or key files. The working folder is not an
  upload folder when it is your home folder or contains it, or lies in a folder whose name
  starts with a dot. To choose the folders yourself, set `FOXHAND_UPLOAD_DIRS` to absolute
  folders separated by `:` (a leading `~` stands for your home folder) in the environment your
  MCP client starts `foxhand mcp` with: for Claude Code, `claude mcp add -e
  FOXHAND_UPLOAD_DIRS=~/uploads ...` or the `env` of the server's entry. It replaces the
  defaults. Files and folders whose names start with a dot below an upload folder, and files
  named like keys (`id_*`, `*.pem`, `*.key` and similar), are refused in any folder, and an
  upload takes at most 10 MB.
- A recipe is saved only by your click on Foxhand's page in Firefox, after you read it:
  nothing the agent sends can save one. Later agent sessions read a saved recipe as your
  instructions, so read it before you save it.
- Tool results mark page content as untrusted, and the agent is told not to follow
  instructions found in pages.
- Text results never return the values of password fields, of one-time code and card number
  fields that the page marks as such for autofill, or of text fields that Firefox filled in from
  your saved logins, addresses or cards, until you edit them, only whether they are filled:
  Firefox fills saved passwords into login pages when they load, and a page you approved
  could otherwise hand yours to the agent. In `read_page`, a password field that the page
  turns into another kind of field stays protected only if the agent read the page, took a
  screenshot of it or acted in it while it was still a password field, and a text field that
  the page puts in its place shows its value.
  When the agent reloads a page, Foxhand loads it without the browser's cache, so Firefox puts
  back no field value. It does the same after the agent goes back or forward to a page that
  Firefox loads again instead of keeping it in memory, except a page that a form sent with
  POST or that holds a frame a form sent with POST, and a page on a site the agent may not act
  on. The page's fields then lose what was typed into them.
  A text field Firefox filled in shows its value again once Firefox no longer highlights it as
  filled in: after you edit it; after the page's own scripts report a change to it, reload the
  page or go back or forward; after the agent goes back or forward to a page that a form sent
  with POST or that holds a frame a form sent with POST, or to a page on a site you had not
  approved and then approve; in a frame, after the agent goes back or forward and only that
  frame changes; after a tab that was unloaded, by you or by Firefox to save memory, is loaded
  again; and after Firefox restores your windows and tabs when it starts again. Possibly also
  after you reopen a tab or window you closed; after the agent goes back or forward and the
  page delays that, or Firefox delays telling Foxhand about the page's request, by more than a
  second, or the computer's clock is set back meanwhile; and to another tool call that reads
  the page while the agent goes back or forward to it.
  Screenshots hide the text of these fields, also in frames from other sites, with a style
  sheet Foxhand adds to each frame, and Foxhand takes no screenshot when a frame does not take
  it, such as a PDF in a frame. There are two exceptions: a frame showing Firefox's error page
  for a page that could not be loaded or does not allow being shown in a frame, and a frame of
  another add-on, such as a password manager's menu, which Foxhand hides together with every
  other frame of the same page or frame, so none of their content is in the screenshot. When
  the page turns a password field into another kind of field after the agent read the page,
  took a screenshot of it or acted in it while it was a password field, a screenshot hides the
  text of every input element in the page, input buttons included, outside its frames. A field
  that is none of these still shows its value.
- Saved screenshots go only into the agent's working folder, as new files, and never over
  an existing file.
- Downloads save only a file served by a site you approved, after any redirects: Foxhand
  checks the address before the request, and the final address before it reads or saves
  anything. They go only into your Firefox download folder, under a plain file name, never
  over an existing file. The file's content reaches the agent only when it reads the file
  with its own tools, outside Foxhand's untrusted marking.

Your agent's own permission settings still apply on top of this, but do not rely on them
alone: many people run agents with prompts turned off.

Avoid using Foxhand on sites where a mistake is costly (banking, health records, admin
panels with destructive actions), and stay nearby while it works.

## Limits

Firefox gives extensions no way to produce real user input, so all clicks and keystrokes
are simulated. Some things therefore do not work:

- actions that need a real user gesture: opening pop-up windows and new tabs (unless you
  allow pop-ups for the site), writing to the clipboard, entering fullscreen, opening a file
  picker,
- sites that ignore simulated events.

The agent is told about these limits and asks you to take such steps yourself.

## Development

See [docs/development.md](docs/development.md) for building, testing and running a
development copy, and [AGENTS.md](AGENTS.md) for the project's conventions.
Architecture decisions are recorded in [docs/adr/](docs/adr/).
