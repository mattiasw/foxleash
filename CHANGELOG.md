# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The README describes Claude Code settings that can make browser tasks faster: allowing
  Foxleash's tools without a prompt, a lower effort level and fast mode.
- `read_page` can return only the lines that contain a text (`find`), optionally only those of
  one role (`role`), each after the lines of the elements it is in, and says how many more
  match. The agent finds an element on a large page without reading the whole tree, also past
  the point where a full read is cut.
- A setting on the settings page, "Open each agent session in its own window", off by default.
  With it on, an agent session's tabs open in a new window of their own instead of changing the
  tab selected in your window, and Foxleash closes that window when the session ends if it
  holds only blank tabs and is not your last window.
- An agent can ask you on one page for all the sites a task needs (`request_sites`): the page
  lists each site and what allowing does for it, and one click on Allow allows them for the
  agent's session, never always, instead of a prompt for each site as the agent opens it.
- Actions (`click`, `hover`, `scroll`, `drag`, `type`, `press_key`, `fill_form` and
  `upload_file`) wait for the page to settle and then say what happened: which element took the
  action, and whether the tab loaded another page (with its address), the page changed, nothing
  changed, the page kept changing, the tab closed, or tabs opened. A read right after an action,
  also in the same `batch`, sees the page the action left, and the agent needs fewer reads.
- The results of actions, `tab_open`, `navigate` and `wait_for` end with a view of the page, so
  the agent does not read the page after each step: the page itself the first time the agent
  gets it, cut to its most relevant lines on a large page with a note on how to read the rest,
  then only the lines that changed, or a line saying nothing changed. `view: false` leaves it
  out, and a `batch` gives one view, after its last step.

### Changed

- Foxhand is now named Foxleash, because another Firefox add-on is named Foxhand. Everything
  that carried the name changed with it: the extension and its add-on id, the native host, the
  MCP server name (`foxleash`), the `FOXLEASH_UPLOAD_DIRS` variable and the install paths. An
  installation of 0.3.0 or earlier is not updated in place: run `npm run teardown` before you
  update the checkout, remove the Foxhand extension in Firefox, then run `npm run setup`.
  Approved sites, blocklist edits and recipes stay with the old extension and have to be
  entered again.
- `read_page` trees are shorter, so they cost fewer tokens: element references are short, such
  as `b12`, a link to the page's own site shows its address as a path starting with `/`, and
  each level is indented by one space. `navigate` takes such a path and loads it on the site the
  tab shows; `tab_open` and `download` ask for the whole address.
- Agents are told at the start how to finish a browser task in fewer steps: put the steps they
  can already spell out into one `batch` call, read each page once, and, in clients that load
  tools on demand, load all the tools a task needs at once. Browser tasks take fewer model
  requests.
- A click or a drag at a point, or `press_key` without an element, is refused and not sent when
  the tab was loading another page, or loaded one, before it could be sent, since its point or
  key was chosen for the page before. A `batch` stops before such a step in a tab an earlier
  step loaded another page in.
- `navigate` to a URL and `tab_open` with a URL answer once the page can be read, instead of
  after every image and script has loaded, so pages open faster. The tab they return has an
  empty title when the page is still loading.
- `navigate` back or forward to a page Firefox kept in memory now answers in a fraction of a
  second instead of about a second later.
- After `navigate` goes back or forward to a page Firefox loads again, Foxleash now loads the
  page's address again instead of reloading it without the browser's cache, so a form in one of
  its frames is not sent again however late Firefox reports it (except for an address with a
  #fragment, which is still reloaded). The page may now come from the browser's cache.

### Fixed

- `tab_open` of a URL that Firefox downloads now reports an error, as `navigate` does, instead
  of returning a tab with no page, also when the URL has a fragment. `navigate` now also reports
  it for such a URL loaded into a tab Firefox unloaded to save memory.
- In Claude Code, large page reads (`read_page` of a long page, `get_page_text`, and `batch`
  results holding them) now reach the agent as the page, not as a file the agent has to search.
- A read or a wait right after a click or a form submit that loads another page now returns the
  new page, instead of the previous one or an error saying the tab shows another kind of page.
- An action after which its tab shows another site now says the action ran and to read the page
  before repeating it, instead of asking to try again.
- `type` and `fill_form` no longer take about a second per text field in a tab that is not the
  active tab of its window, and `fill_form` there no longer stops after four text fields.
- `wait_for` with `navigation` true, called right after a click on a link, no longer waits its
  whole timeout and fails when the new page has already loaded.

## [0.3.0] - 2026-11-06

### Added

- `get_page_text` can continue a long page where a cut read stopped, instead of reading it
  again from the start.

### Changed

- The built-in blocklist in the settings is in alphabetical order.
- Agents are told that subagents and parallel agents sharing a session share its tab group and
  the sites you approved, and that a tab's `active` field is the active tab of its window.

### Fixed

- `navigate` no longer returns the previous page when the tab is slow to start loading the new
  one, and `tab_open` no longer returns a tab before its page loaded: both wait for the page, and
  report an error when no page loads within 30 seconds, as for a URL that Firefox downloads.

## [0.2.0] - 2026-10-31

### Added

- A Recipes section on the settings page, where you write, edit and delete recipes: a task's
  steps written down with the sites it uses. A deleted recipe can be restored with Undo.
- Agents can propose a recipe: Foxleash opens it on a page in the session's tab group, where you
  read it, edit it, and save or discard it. The page shows all of the recipe, its name and
  description included, with no scrolling inside the fields. Proposing the name of a saved
  recipe shows the saved version and the changes to its steps.
- Agents can read the recipes you saved: the list of their names, descriptions and sites, and
  one recipe with its steps. Foxleash gives the agent a recipe as your instructions, while page
  content stays marked as untrusted.
- Agents can ask you to allow a saved recipe's sites for their session in one click, on a
  Foxleash page that lists the sites. Nothing is allowed always this way, and sites on your
  blocklist or that you refused in the session stay so.
- A `run_recipe` prompt starts a saved recipe from your agent: in Claude Code,
  `/mcp__foxleash__run_recipe <name>`.

### Removed

- Support for Firefox 140 and 141, including Firefox ESR 140, which Mozilla no longer
  updates. Foxleash now requires Firefox 142 or later.

### Fixed

- `type` into an editable area whose caret sits just before its first line, as in a Gmail reply
  typed right after opening it, now writes on that line instead of above it, so no extra empty
  line is left above the signature.
- A Forget click on the settings page is no longer lost when it is the click that brings Firefox
  back into focus after an agent opened or closed a tab.

## [0.1.1] - 2026-10-27

### Changed

- The agent is told that each newline in the text it types into an editable area, such as an
  email body, starts a new line, and to end an email's text with a newline, so a blank line
  stays between the text and the signature.
- The agent is told that a drag's drop being accepted does not show that the page changed, and
  to read the page afterwards to check.

### Fixed

- A tab in which Foxleash asked you to approve a site no longer gets a Forward button that
  leads to a blank page after Firefox unloads it to save memory and you select it again.
- `read_page` shows the text in an editable area, such as an email's message body, as its
  value, as it does for a text field, also when the agent reads only the interactive elements.
- `screenshot` works on pages where another add-on, such as a password manager, shows a frame
  of its own, for example its menu in a login field. That frame and the other frames of the
  same page or frame show blank in the screenshot.
- `drag` moves items in sortable lists built with libraries such as SortableJS. Before, such a
  list stayed as it was although `drag` reported a drop.

## [0.1.0] - 2026-10-25

### Added

- The Firefox extension opens and navigates tabs for your agent, keeping each session's tabs
  in its own orange "Foxleash" tab group.
- When an agent session ends, its Foxleash tab group closes if it holds only blank tabs;
  groups with pages stay open.
- Firefox can now start the Foxleash native host, which relays your agent's requests to the
  extension.
- An MCP server gives your agent the `tabs_list`, `tab_open` and `navigate` tools, so it can
  list, open and navigate the tabs in its Foxleash tab group in your Firefox. `navigate`
  reloads a page without the browser's cache, also after going back or forward to a page that
  Firefox loads again instead of keeping it in memory, unless a form sent it with POST or its
  site is not approved, so Firefox puts back no value it filled in from your saved logins,
  addresses or cards, and the page's fields lose what was typed into them.
- `npm run setup` installs the signed Foxleash extension in Firefox (you confirm once),
  connects Firefox to Foxleash and registers Foxleash with Claude Code; `npm run teardown`
  removes the native host and the registration.
- `npm run doctor` checks your setup, the Foxleash host of every running Firefox and the
  extension, and says what to do about each problem it finds.
- Tabs on sites you have not approved show your agent only the site's address, not the
  page's path, query or title, and tabs showing a local file only that they are local files.
- The extension's settings page lists the sites you allowed always and lets you revoke each
  one.
- Financial and health sites on a built-in blocklist are refused before Foxleash opens or
  reloads them, even if you approved the site, and a tab showing one shows your agent only
  the site's address.
- Before your agent opens a page on a site you have not approved, Foxleash asks you in that
  tab: for this session, always, or not at all. Only your click can allow it.
- The Foxleash toolbar button shows ON on the tabs your agent session can use; clicking it
  opens the settings.
- The settings page lets you edit the blocklist, and see and forget what you allowed or
  refused for each running agent session, and the prompts you closed without an answer.
- `npm run probe -- <url>...` opens each page in its own Foxleash tab group after you allow
  the site, and writes a JSON and a Markdown report of which synthetic clicks, typing and key
  presses work there.
- Tool results put page content between a start line and an end line that carry the same
  random id, so text in a page cannot pass for the end of it.
- Your agent can read a page's structure with the `read_page` tool: its elements with their
  roles, names and states, its visible text, and a reference to each element, with file fields
  marked so your agent can find them for `upload_file` even without a label, but never with
  the name of a file chosen in one. The values of password fields, of one-time code and card
  number fields that the page marks as such for autofill, and of text fields that Firefox
  filled in from your saved logins, addresses or cards, until you edit them, are never read
  out, only whether they are filled. A password field the page turns into another kind of
  field stays protected once your agent has read the page, taken a screenshot of it or acted
  in it while it was a password field.
- Your agent can read a page's text with the `get_page_text` tool: the main content first,
  then the rest of the page, on sites you approved.
- Your agent can take a PNG screenshot with the `screenshot` tool: of what a tab shows, also
  in the background, or of one element, on sites you approved, with the text of password
  fields, of one-time code and card number fields that the page marks as such for autofill,
  and of text fields that Firefox filled in from your saved logins, addresses or cards, until
  you edit them, hidden. With `saveTo` it also saves the screenshot as a new file in its working
  folder, never over an existing file.
- Your agent can upload files from your computer with the `upload_file` tool, into a page's
  file field or dropped on the page, on sites you approved. It reads only from the upload
  folders (its working folder and `~/Downloads` unless you set `FOXLEASH_UPLOAD_DIRS`), never
  dotfiles or files named like keys, and at most 10 MB per upload.
- Your agent can click, hover, scroll and drag in a page with the `click`, `hover`, `scroll`
  and `drag` tools, on an element from `read_page` or at a point, on sites you approved.
  Clicks on links and form buttons that lead to another site, or out of the browser such as to
  an email address, are refused; your agent opens a page on another site with `navigate`,
  which asks you first. A link or form button that opens a new tab, clicked or pressed with
  Enter, opens nothing while Firefox's pop-up blocker stops it, as it does unless you allow
  pop-ups for the site; a new tab that a page in the agent's Foxleash tab group opens, also
  after your own click, joins that group.
- Your agent can read a page's console messages, uncaught errors and unhandled promise
  rejections with the `read_console` tool, filtered by level and pattern, only from pages
  that loaded on sites you approved.
- Your agent can read a tab's network requests with the `read_network` tool (URLs, methods,
  status, timing and headers, filtered by URL text), with the Cookie, Set-Cookie,
  Authorization and Proxy-Authorization values hidden and no bodies, only from pages that
  loaded on sites you approved.
- Your agent can wait for text, an element or a navigation in a page (`wait_for`), switch
  between and close the tabs in its Foxleash tab group (`tab_select`, `tab_close`), and resize
  the window that holds the group (`resize_window`).
- Your agent can type into text fields and editable areas with `type`, and press keys with
  `press_key`, which submits forms with Enter, moves focus with Tab, closes popovers and
  dialogs with Escape and picks options in a list with the arrow keys, on sites you approved.
  Enter on a link or in a form that leads to another site or out of the browser is refused, as
  clicks are. `type` refuses a field that Firefox filled in from your saved logins, addresses
  or cards, until you edit it. It adds text after what a text field holds, and in an editable
  area at the caret the page put there, or else at its start, so an email signature stays
  below what your agent writes.
- Your agent can fill in several form fields in one call with `fill_form`: text fields,
  selects, checkboxes and radio buttons, with a result for each field. It never submits the
  form.
- Your agent can run several tool calls in one call with `batch`, up to 20, in order: it
  stops at the first step that fails and returns each step's result, and every step is
  checked as when its tool is called on its own. A rule in your MCP client that denies or asks
  for one tool does not cover that tool inside `batch`: set it for `batch` too.
- Your agent can save the file at a link into your Firefox download folder with the `download`
  tool, under a plain file name it chooses and never over an existing file, also where Firefox
  would open the file in another application. The link, and the address the file comes from
  after any redirects, must be on sites you approved; the request carries your cookies for the
  site, and files are limited to 100 MiB.

### Fixed

- Tabs your agent opens on a page of a site you approved no longer come back blank, or with a
  Forward button that leads to a blank page, when Firefox unloads them to save memory and you
  select them again.
- Closing a tab whose page asks you to confirm leaving it no longer holds up your agent's other
  tab closes and session ends until you answer. The agent learns within seconds that the page is
  waiting for you, and no longer hears that the tab closed when you choose to stay on the page.
- Your Firefox window, or Firefox itself, no longer closes when your agent closes a tab while a
  tab it is opening in the same window fails to open.
