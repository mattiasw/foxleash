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
- `npm run setup` connects Firefox to Foxhand and registers Foxhand with Claude Code;
  `npm run teardown` removes both.
- `npm run doctor` checks your setup, the Foxhand host of every running Firefox and the
  extension, and says what to do about each problem it finds.
- Tabs on sites you have not approved show your agent only the site's address, not the
  page's path, query or title, and tabs showing a local file only that they are local files.
- The extension's settings page lists the sites you allowed always and lets you revoke each
  one.
