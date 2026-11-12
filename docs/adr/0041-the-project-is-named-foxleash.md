# 0041: The project is named Foxleash, in every identifier

**Status:** Accepted, 2026-11-12.

## Context

The project was named Foxhand up to version 0.3.0, while in development: the repository was
private and the extension was signed but not listed. In October 2026 another Firefox
extension with the same function, a bridge between an MCP client and the user's Firefox, was
renamed to Foxhand and listed on addons.mozilla.org under the slug `foxhand`.

Two things followed. On Linux that extension's helper program installs to
`~/.local/share/foxhand/foxhand-host`, the path our launcher used, so on a computer with both
the later installation replaced the other's program (read from both projects' sources, not
run). And a second listing with the same name and the same function would confuse users and
reviewers.

No registered trademark was found for either name (USPTO and TMview, 2026-11-12). The npm
name `foxleash`, the addons.mozilla.org slug and the GitHub repository name were free.

## Decision

The project is named Foxleash, in one form everywhere and with nothing left of the former
name:

- the extension's name and its add-on id, `foxleash@mattiasw.com`
  (`apps/extension/manifest.json`, `EXTENSION_ID` in `packages/protocol/src/index.ts`),
- the native host name `foxleash` (`NATIVE_HOST_NAME`), the launcher
  `~/.local/share/foxleash/foxleash-host`, the cache folder `~/.cache/foxleash/` and the
  socket folder (`apps/server/src/install.ts`, `apps/server/src/socket-dir.ts`),
- the MCP server name `foxleash`,
- the environment variables (`FOXLEASH_UPLOAD_DIRS`), the workspace packages
  (`@foxleash/...`) and the release file names (`foxleash-x.y.z.xpi`),
- the tab group title, the documentation and the add-on listing.

The name says what sets the project apart: the agent works in the user's Firefox on a leash
that the user holds ([0002](0002-safeguards-live-in-foxleash-not-the-mcp-client.md)). A
leash is also an old collective noun for foxes.

The earlier records in this folder were changed only by substituting the name. Their
decisions stand as written.

## Alternatives rejected

- **Keep the name.** It costs nothing while the project is private, and the other project
  does not hold a trademark. But the clash would be met on the day the extension is listed
  or the server is published, when a rename also means a new add-on, a new npm package and
  migration code for installed hosts.
- **Keep the name with a qualifier.** The clash is in the distinctive word, in the same
  store and for the same function, and a qualifier leaves the install path, the slug and
  the package name contested.
- **Keep the add-on id `foxhand@mattiasw.com`.** Firefox and addons.mozilla.org identify an
  add-on by its id, so keeping it would have kept the stored settings of existing
  installations and the add-on's record. But an id cannot change once users have the
  add-on, and it would have left the former name in the manifest and in every native
  messaging manifest for good. Only development installations existed.
- **Code that removes a former installation** (the native host manifest, the launcher and
  the MCP registration under the old name). Only development installations existed, and
  `npm run teardown` at the last commit before the rename removes them.

## Consequences

- An installation of 0.3.0 or earlier is not updated in place. Its owner runs
  `npm run teardown` before updating the checkout, removes the old extension in Firefox and
  sets up again. Approved sites, blocklist edits and recipes stay with the old extension.
- The first version signed under the new id is a new add-on on addons.mozilla.org. The
  versions up to 0.3.0 stay under the former name and id.
- The former name appears in this record and in the changelog entry of the rename, and
  nowhere else in the repository.
- A later rename costs more than this one did: once the extension is listed or the server
  is published, the add-on id, the slug and the package name are fixed.
