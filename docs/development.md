# Development

## Requirements

- Linux, Node.js 24 or later (the version in `.nvmrc`), npm 11
- Firefox 142 or later for running the extension

## Setup

```sh
npm ci
```

This also installs the Git hooks: the pre-commit hook formats and lints staged files with
Biome, and the pre-push hook runs the type check and the unit tests.

## Layout

The repository is an npm workspaces monorepo run by Turborepo:

- `apps/extension/`: the Firefox extension
- `apps/server/`: the `foxhand` command (MCP server, native host, installer)
- `packages/protocol/`: messages and contracts shared by both
- `packages/tsconfig/`: shared TypeScript configuration
- `e2e/`: end-to-end tests in a real, headless Firefox

## Checks

| Check | Command |
|---|---|
| Lint and format | `npm run lint` |
| Type check | `npm run typecheck` |
| Unit tests | `npm test` |
| Build | `npm run build` |
| AMO source archive | `npm run build:amo` |
| Release checks | `npm run check:release -- <subcommand>` |
| End-to-end tests | `npm run e2e` |

The server's TypeScript runs directly on Node (type stripping), so it has no build step.
Running Node with `--preserve-symlinks` breaks this for the workspace packages: Node
refuses to strip types from files it sees under `node_modules`.

## End-to-end tests

`npm run e2e` builds the extension, then starts a pinned Firefox headless with a temporary
home directory and a temporary `XDG_RUNTIME_DIR`, so it never touches your own Firefox or
Foxhand. It installs the native host into that home, installs the extension over WebDriver
BiDi, serves fixture pages from a local HTTP server, and calls the real MCP tools through
`foxhand mcp`, as an MCP client would.

The suite runs on linux x64 only. The first run downloads Firefox into
`${XDG_CACHE_HOME:-~/.cache}/foxhand-firefox` and checks it against the sha256 pinned in
`bin/firefox-version.json`; later runs reuse it. To raise the pin, set the new version in
that file together with the sha256 of `linux-x86_64/en-US/firefox-<version>.tar.xz` from
Mozilla's `https://archive.mozilla.org/pub/firefox/releases/<version>/SHA256SUMS`, as a change
of its own (see ADR 0003).

The tests also act in the extension's own pages, which WebDriver reaches only with system
access, so the test Firefox starts with `--marionette` and `--remote-allow-system-access`
(see [ADR 0008](adr/0008-e2e-tests-act-in-extension-pages-through-bidi-and-marionette.md)).
The harness opens the session over Marionette (`WebDriver:NewSession` with
`webSocketUrl: true`) and connects BiDi to the WebSocket URL it returns. BiDi installs the
extension, opens, navigates and closes tabs and evaluates script in them; Marionette only
clicks (`WebDriver:FindElement` and `WebDriver:ElementClick`) and brings a tab to the front
(`WebDriver:SwitchToWindow`), because BiDi has no input in extension pages, refuses
`browsingContext.activate` there, and a click from script is not trusted. The profile pins
the extension's internal UUID (`EXTENSION_UUID` in `e2e/firefox.ts`) with the
`extensions.webextensions.uuids` pref, so the settings page is
`moz-extension://<EXTENSION_UUID>/options.html`.
`harness.seedSettings` writes `storage.local` from that page and is the only way tests write
settings: the extension has no test hook.

The profile keeps Firefox's pop-up blocker on (`dom.disable_open_during_load`), which
Firefox's remote agent would otherwise switch off, so a test sees the pop-up blocking users
get. `firefox.allowPopups(origin)` allows pop-ups for a site, as a user's pop-up exception
does, `firefox.resetPopups(origin)` removes that exception again, and
`firefox.blockedPopups(url)` reads how many pop-ups Firefox blocked in a tab.

The profile also turns on Firefox's credit card autofill
(`extensions.formautofill.creditCards.enabled`), which the remote agent would otherwise switch
off. `firefox.fillCreditCard(context, numberSelector, card)` clicks the card number field, so
Firefox identifies the card form, then has Firefox's form autofill fill the card as a pick from
that field's pop-up does. It stores no card: Firefox encrypts a stored card's number with the OS key store
(on Linux the Secret Service over D-Bus), which the test Firefox would reach only as the
developer's own keyring.

A test that answers a page's beforeunload prompt itself starts Firefox with
`harness.startFirefox(EXTENSION_DIST, { holdBeforeUnloadPrompts: true })`. That asks WebDriver
to leave those prompts open (`unhandledPromptBehavior: { beforeUnload: "ignore" }`) instead of
accepting them at once, and lets them show without a click on the page first. The test waits
for the prompt and answers it with `firefox.watchPrompt`, which uses BiDi's
`browsingContext.userPromptOpened` event and `browsingContext.handleUserPrompt`.

A test that restarts Firefox starts it with
`harness.startFirefox(EXTENSION_DIST, { restoreSession: true })`, which sets
`browser.startup.page` to 3 so Firefox opens the last session's windows and tabs, and restarts
it with `harness.restartFirefox(EXTENSION_DIST, { restoreSession: true })`. That calls
`firefox.quit()`, which flushes each loaded tab's state into the session store and quits as
File > Quit does, then starts Firefox on the same profile and installs the extension again.
After a restart the test seeds its settings and connects a new MCP session: sessions end with
the Firefox that quit, and whether the settings survive is not checked.

The approval prompt's buttons answer only a second after its page is both visible and
focused, so `harness.waitForArmed` first brings the prompt's tab to the front with
`firefox.activate`, which sends the same Marionette `WebDriver:SwitchToWindow` that
`firefox.click` sends before it clicks, so a click right after it changes neither focus nor
visibility. Tests answer the prompt only with `firefox.click`: a click from script is not
trusted, and the prompt ignores it.

## Extension

`npm run build` bundles the extension into `apps/extension/dist/`: the manifest with the
version from `apps/extension/package.json`, unminified `background.js`, `options.js`,
`approve.js` and `content.js`, the script Foxhand injects into the pages of the agent's tabs,
the settings page `options.html` and the approval prompt `approve.html` with their shared
`pages.css`, and the icon. It then lints that folder with web-ext, ignoring web-ext's
`WEB_EXT` environment variables and config files, and fails on any error or warning.

`npm run dev` rebuilds `background.js`, `options.js`, `approve.js` and `content.js` whenever
their TypeScript source changes and runs Firefox through `web-ext run`, which reloads the
extension after each rebuild. It writes the manifest, the icon and the pages (`src/*.html`
and `src/*.css`) once at start, so restart it after changing them. Firefox uses a persistent
profile in `$XDG_CACHE_HOME/foxhand/dev-profile` (by default
`~/.cache/foxhand/dev-profile`), so what you set up there, such as logins, stays between
runs. It needs a desktop with Firefox 142 or later.

## AMO source archive

Mozilla reviewers rebuild the extension from a source archive. `npm run build:amo` builds
`artifacts/foxhand-source-<version>.zip`, then extracts it into a temporary directory and
runs `npm ci && npm run build` there, as a reviewer would. From that clean copy it builds
`artifacts/foxhand-<version>.xpi`. It fails unless:

- every tracked file matches a ship or exclude rule in `bin/build-amo.ts`;
- the archive's files are exactly the ones in `bin/amo-source-files.txt`, read from the git
  index;
- no tracked symlink or submodule sits at or above a shipped path, and no shipped file is
  reached through a symlink in the working tree;
- no `node_modules` folder sits above the temporary directory, where the clean build could
  load packages a reviewer does not have;
- the clean rebuild is identical to the normal build in `apps/extension/dist/`.

The two files appear in `artifacts/` only when every check passes.

The archive ships `bin/amo-source-readme.md` as its `README.md`, with the exact Node and npm
versions of the build filled in. The command needs `git`, `zip`, `unzip`, `diff` and network
access for `npm ci`.

When you add, move or delete a file that the extension build reads, edit
`bin/amo-source-files.txt` in the same commit, one path per line in `LC_ALL=C sort` order,
and `git add` it: the check reads the staged list. When the command reports a tracked file
it cannot classify, add a ship or exclude rule for it in `bin/build-amo.ts`.

## Release checks

`npm run check:release -- <subcommand>` checks one stage of a release. Each subcommand runs
all of its checks and prints one `INFO:`, `WARNING:` or `FAIL:` line per finding:

- `changelog`: `CHANGELOG.md` has the Keep a Changelog shape: `## [Unreleased]` first, then
  `## [x.y.z] - YYYY-MM-DD` sections with real dates and descending versions, each holding
  only `### Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or `Security` headings, in
  that order, with `- ` entries and their indented continuation lines.
- `listing`: `docs/amo/listing-claims.json` maps each capability and safeguard that
  `docs/amo/listing.md` states to the tools and code that provide it. Every capability claim
  occurs in a bullet of the listing's capability list and every safeguard claim in the
  listing, and every bullet of the capability list has a capability claim and every bullet
  of the safeguard list a safeguard claim; the tools the server registers are exactly the
  claimed ones; each safeguard's evidence holds (a tracked file contains, or lacks, a
  string), and a safeguard with no evidence fails, because it is not built yet; every
  permission and data collection category in the manifest is explained in the listing, and
  every permission the listing explains is in the manifest; the Permissions section, which
  goes to AMO as each version's notes to reviewers, holds at most the 3000 characters AMO
  takes. With a previous tag, it prints
  the diffs of the manifest, the listing and `bin/amo-source-files.txt` between that tag and
  the working tree, and fails when the manifest's permissions, content script matches or
  data declarations changed but the listing did not.
- `pre-roll [--bump=patch|minor|major]`: the changelog shape; HEAD is `main`, equal to
  origin's `main`, with a clean working tree; every version field agrees; the latest tag is
  on origin; Unreleased has entries; the bump is at least what the change types need
  (`Removed` major, `Added` or `Deprecated` minor, else patch; before 1.0.0 a major change
  needs only minor); the next tag exists neither here nor on origin; and the newest CI run of
  `ci.yml` on `main` for HEAD succeeded. It also runs the `listing` checks. The first release
  takes no `--bump`; every later one needs it.
- `post-roll <version>`: Unreleased is empty, the top section is `## [<version>] - <today>`
  with exactly HEAD's Unreleased entries, the rest of the file is unchanged, `<version>` is
  at least the bump those entries need, and `CHANGELOG.md` is the only modified file.
- `post-bump <version>`: every version field is `<version>`, and the only modified files are
  the root and workspace `package.json` files and `package-lock.json` (none when HEAD
  already has `<version>`).
- `pre-push`: with `<version>` the root `package.json` version, HEAD is the branch
  `release/<version>`, local `main` has no commit that origin's `main` lacks, and on top of
  origin's `main`, whose newest CI run succeeded, sit only `Update changelog for <version>`
  and, after a bump, `Bump version to <version>`; together they change only `CHANGELOG.md`
  and the version fields, by at least the bump origin's Unreleased entries need; HEAD
  carries exactly the annotated tag `v<version>`, which origin does not have yet; the
  working tree is clean; and `npm run build:amo` has built the XPI and source archive of
  that version.
- `artifacts <version> [--unsigned <path>]`: the signed XPI in `web-ext-artifacts/` holds the
  signature files and exactly the files of the unsigned XPI (default
  `artifacts/foxhand-<version>.xpi`), byte for byte except `manifest.json`, which may differ
  only in its JSON formatting (AMO's signed copy drops the final newline), and its manifest
  has `<version>`.

The version fields are the root and workspace `package.json` files and `package-lock.json`.
The extension's built manifest takes its version from `apps/extension/package.json`; the
source `apps/extension/manifest.json` has no `version`.

The exit status is 0 when every check passes, 1 when one fails, 2 on a usage error, and 3
when nothing fails but a warning (such as a bigger bump than the changes need, or a
breaking change mentioned in a smaller bump) needs your confirmation. CI runs the
`changelog` and `listing` checks.

## Releasing

A release starts from `main`; its commits are made on a `release/x.y.z` branch and reach
`main` only through the push. It runs the release checks in this order: `pre-roll`,
`post-roll <version>`, `post-bump <version>`, `pre-push`, `artifacts <version>`. What each
one verifies is in [Release checks](#release-checks), as are the version fields: the root
and workspace `package.json` files and `package-lock.json`, with the extension's manifest
taking its version from `apps/extension/package.json`.

1. Run `npm run check:release -- pre-roll --bump=<patch|minor|major>`. It prints the next
   version, `x.y.z` below. The first release, 0.1.0, runs `pre-roll` without `--bump`.
2. Create the release branch with `git switch --no-track -c release/x.y.z`, then roll the
   changelog: move the entries under `## [Unreleased]` unchanged into a new
   `## [x.y.z] - YYYY-MM-DD` section, dated today, and leave an empty `## [Unreleased]`
   above it. Run `npm run check:release -- post-roll x.y.z` and commit `CHANGELOG.md` as
   `Update changelog for x.y.z`.
3. Bump the version with
   `npm version <patch|minor|major> --workspaces --include-workspace-root --no-git-tag-version --ignore-scripts`,
   run `npm run check:release -- post-bump x.y.z` and commit the six version files as
   `Bump version to x.y.z`. The first release has no bump and no such commit.
4. Run `npm run lint`, `npx turbo run typecheck test --force` and `npm run build:amo`, which
   builds `artifacts/foxhand-source-x.y.z.zip` and `artifacts/foxhand-x.y.z.xpi`.
5. Create the annotated tag with `git tag -a vx.y.z -m "vx.y.z"` and run
   `npm run check:release -- pre-push`. Then check that every entry of
   `artifacts/foxhand-x.y.z.xpi` survives the trip to `web-ext sign`: none that web-ext's
   default ignores would leave out (a path component that starts with `.`, is
   `node_modules`, or ends in `.xpi` or `.zip`) and none the `artifacts` check refuses as
   unsafe. On a match, stop before pushing: the tag is still local, so deleting it and the
   release branch undoes the release, and the fix is a build change. Otherwise push the
   release branch to origin's `main` and the tag together with
   `git push --atomic --no-follow-tags origin refs/heads/release/x.y.z:refs/heads/main refs/tags/vx.y.z`.
   Then move local `main` to the pushed commit with `git switch main`,
   `git merge --ff-only release/x.y.z` and `git branch -d release/x.y.z`.
6. Once CI has passed on the pushed commit, sign the XPI from the clean copy,
   `artifacts/foxhand-x.y.z.xpi`, as an unlisted version on addons.mozilla.org.
   `web-ext sign` takes a directory, so extract the XPI and pass that directory as
   `--source-dir`. Before extracting, check the entry names again as in step 5. Then
   extract it, stop on any unzip warning, and check that the folder holds exactly the XPI's
   files, as regular files (web-ext follows a symbolic link).
   Run `web-ext sign` with `--channel unlisted`, with `WEB_EXT_API_KEY` and
   `WEB_EXT_API_SECRET` (an AMO API key pair) in the environment, with the source archive
   attached by `--upload-source-code artifacts/foxhand-source-x.y.z.zip`, and with
   `--amo-metadata` naming a JSON file whose `version` object carries
   `"compatibility": ["firefox"]` and `approval_notes`. The approval notes are the body of the
   Permissions section of `docs/amo/listing.md`, which goes with every version; the
   compatibility follows its Compatibility section.
7. Put the signed XPI in `web-ext-artifacts/foxhand-x.y.z.xpi` and run
   `npm run check:release -- artifacts x.y.z`.
8. Create a draft GitHub release for the tag `vx.y.z` with `foxhand-x.y.z.xpi` attached,
   review it and publish it.

## Server

Each subcommand runs as `node apps/server/src/main.ts <subcommand>`; `--help` lists them.

`npm run setup` (the `install` subcommand) writes the launcher to
`~/.local/share/foxhand/foxhand-host` and the native manifest to
`~/.mozilla/native-messaging-hosts/foxhand.json`; both paths derive from `$HOME` only. The
launcher runs this checkout's `main.ts` with the absolute path of the Node that ran setup,
so rerun setup after moving or switching checkouts or Node versions.
`npm run setup -- --no-claude` and `npm run teardown -- --no-claude` leave Claude Code's
user configuration unchanged, for a checkout that should not touch it.

Setup's last step installs the extension. It runs
`gh release download v<version> --repo github.com/mattiasw/foxhand --pattern foxhand-<version>.xpi`
into `~/.cache/foxhand/foxhand-<version>.xpi` (from `$HOME` only, like the other paths) and
opens that file in Firefox, which asks you to confirm the installation. The repository names
its host, so `GH_HOST` or a gh login to another host cannot change where the file comes from.
`<version>` is this checkout's version, not GitHub's latest release, so the extension matches
the checkout's server and host, and a release that does not exist yet fails instead of
installing an older extension. The file is kept, because Firefox reads it again when you
confirm. `npm run setup -- --xpi <path>` opens a local file instead; a relative path resolves
against the directory `npm run` was started from. `npm run setup -- --no-extension` skips the
step. Firefox is started detached, so setup neither waits for it nor stops it.

The host listens on `<socket directory>/<pid>.sock`. The socket directory is the first of
`$XDG_RUNTIME_DIR/foxhand` and `/run/user/<uid>/foxhand` whose base directory (that is,
`$XDG_RUNTIME_DIR` or `/run/user/<uid>`) is a real directory owned by you with no group or
other permission bits, else `/tmp/foxhand-<uid>`.

Foxhand creates the socket directory with mode 0700. It refuses one that is a symlink, belongs
to another user, or has group or other permission bits, and it never changes an existing
directory's mode or owner.

The host and the MCP server pick the directory the same way, so they meet even when an MCP
client starts the server without `XDG_RUNTIME_DIR`, as long as Firefox's `XDG_RUNTIME_DIR` is
`/run/user/<uid>` or unset (the usual desktop session). A test harness sets `XDG_RUNTIME_DIR`
to the same private temporary directory for both processes, so they meet in a socket directory
of their own.

To run the host by hand, start `node apps/server/src/main.ts host`. It reads native messaging
frames (a 4-byte little-endian length, then UTF-8 JSON) on stdin and writes them on stdout, and
logs to stderr. It exits when stdin ends or on SIGTERM, SIGINT or SIGHUP, and removes its socket
file. When Firefox starts it, its stderr shows up in Firefox's Browser Console. The socket file
is readable and writable by you only.

To run the MCP server by hand, start `node apps/server/src/main.ts mcp`. It speaks MCP
(newline-delimited JSON-RPC) on stdin and stdout and logs to stderr. It connects to the newest
host only on the first tool call, and exits when stdin ends. An MCP client built on the SDK's
`StdioClientTransport` must pass `XDG_RUNTIME_DIR` (and `HOME`) in its `env` when it wants a
private socket directory: the SDK's default environment leaves `XDG_RUNTIME_DIR` out, and the
server then falls back to `/run/user/<uid>/foxhand`, the running user's real Firefox.

`npm run doctor` (the `doctor` subcommand) changes nothing in your setup. It reads the native
manifest and checks its name, type, allowed extension and launcher path. It runs the launcher
the way Firefox does, but with only `HOME`, `PATH=/usr/bin:/bin` and a private temporary
`XDG_RUNTIME_DIR` in its environment, so the host it starts never joins the real socket
directory: it sends one extension hello, expects a welcome, ends stdin and expects a clean
exit, then removes the temporary directory. It runs `claude mcp get foxhand` and compares the
registered command with this checkout. It checks the socket directory with the same rules as
the host, and makes one `mcp` hello and welcome round trip over each socket of a running
process, reading the extension's state from the welcome. The extension reports its access to
all websites when it connects to the host and again whenever the user grants or revokes it, so
that line shows the current state.

## Probing synthetic input

`npm run probe -- <url>...` (the `probe` subcommand) measures which kinds of synthetic input
work on real pages, to tune how Foxhand clicks and types. With Firefox running and the
extension connected, it opens each URL in a new tab in the probe's own Foxhand tab group.
When Firefox asks in that tab whether to allow the site, answer there; the probe waits up to
10 minutes per URL. It then runs a fixed check bundled in the extension in the page and moves
on to the next URL.

It writes two reports, `<path>.json` and `<path>.md`, and never replaces an existing file.
`--out <path>` sets the path without its extension; by default it is
`foxhand-probe-<date>-<time>` in the current folder. Through npm, the current folder and so a
relative `--out` path are the Foxhand folder.

What the probe does in a page:

- It types short markers such as `fxsetter` into the first text field (never a password field,
  nor one marked for a password or a one-time code), the first editable area and the first
  rich editor (such as Gmail's compose window or a Google Docs document) it finds. It restores
  a text field's value afterwards, but not an editor's text, so run it on a scratch document or
  a draft. The page reacts to the markers as it would to your typing, for example by searching
  for them.
- It clicks only an expand or collapse toggle, and then clicks it back, and a link to a
  place on the same page.
- It never submits a form itself, never presses Enter or Tab in the page's own elements, and
  never follows a link off the page. It tests those on elements of its own, which it removes
  again.
- The report holds no page text: per element, only its tag name, type, role, editor kind and
  up to three class names.

To run it in your everyday Firefox profile, for example against your own logged-in sites:

1. `npm run build`, then `npm run setup -- --no-extension` to install the native host.
2. In Firefox, open `about:debugging`, choose This Firefox, then Load Temporary Add-on, and
   pick `apps/extension/dist/manifest.json`. Firefox removes the add-on again when it
   restarts.
3. Run `npm run probe -- <url>...` and allow each site in its tab when Foxhand asks.

## Dependency updates

Dependabot opens pull requests every Thursday: npm updates grouped into one for development
and one for production dependencies, and one per GitHub Action. It proposes a new release only
once it is 3 days old; security updates skip that wait. The `Auto-merge Dependabot` workflow
squash-merges such a pull request once CI and all of its checks pass; one that fails stays open
for a person to fix. A pull request whose branch moved after its checks ran is not merged on
those checks; the CI run for its new head merges it. After merging, the workflow starts CI on
`main` itself, because a merge made with its own token starts no push run. The CI run it starts
tests the updates merged together.
