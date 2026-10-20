# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The Firefox extension opens and navigates tabs for your agent, keeping each session's tabs
  in its own orange "Foxhand" tab group.
- When an agent session ends, its Foxhand tab group closes if it holds only blank tabs;
  groups with pages stay open.
- Firefox can now start the Foxhand native host, which relays your agent's requests to the
  extension.
- An MCP server gives your agent the `tabs_list`, `tab_open` and `navigate` tools, so it can
  list, open and navigate the tabs in its Foxhand tab group in your Firefox.
- `npm run setup` installs the signed Foxhand extension in Firefox (you confirm once),
  connects Firefox to Foxhand and registers Foxhand with Claude Code; `npm run teardown`
  removes the native host and the registration.
- `npm run doctor` checks your setup, the Foxhand host of every running Firefox and the
  extension, and says what to do about each problem it finds.
- Tabs on sites you have not approved show your agent only the site's address, not the
  page's path, query or title, and tabs showing a local file only that they are local files.
- The extension's settings page lists the sites you allowed always and lets you revoke each
  one.
- Financial and health sites on a built-in blocklist are refused before Foxhand opens or
  reloads them, even if you approved the site, and a tab showing one shows your agent only
  the site's address.
- Before your agent opens a page on a site you have not approved, Foxhand asks you in that
  tab: for this session, always, or not at all. Only your click can allow it.
- The Foxhand toolbar button shows ON on the tabs your agent session can use; clicking it
  opens the settings.
- The settings page lets you edit the blocklist, and see and forget what you allowed or
  refused for each running agent session, and the prompts you closed without an answer.
- `npm run probe -- <url>...` opens each page in its own Foxhand tab group after you allow
  the site, and writes a JSON and a Markdown report of which synthetic clicks, typing and key
  presses work there.
- Tool results put page content between a start line and an end line that carry the same
  random id, so text in a page cannot pass for the end of it.
- Your agent can read a page's structure with the `read_page` tool: its elements with their
  roles, names and states, its visible text, and a reference to each element. The values of
  password, one-time code and card number fields are never read out, only whether they are
  filled.
- Your agent can read a page's text with the `get_page_text` tool: the main content first,
  then the rest of the page, on sites you approved.
- Your agent can take a PNG screenshot with the `screenshot` tool: of what a tab shows, also
  in the background, or of one element, on sites you approved, with the text of password,
  one-time code and card number fields hidden. With `saveTo` it also saves the screenshot as
  a new file in its working folder, never over an existing file.
- Your agent can upload files from your computer with the `upload_file` tool, into a page's
  file field or dropped on the page, on sites you approved. It reads only from the upload
  folders (its working folder and `~/Downloads` unless you set `FOXHAND_UPLOAD_DIRS`), never
  dotfiles or files named like keys, and at most 10 MB per upload.
- Your agent can click, hover, scroll and drag in a page with the `click`, `hover`, `scroll`
  and `drag` tools, on an element from `read_page` or at a point, on sites you approved.
  Clicks on links and form buttons that lead to another site are refused; your agent opens
  such a page with `navigate`, which asks you first.
