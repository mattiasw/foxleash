# Development

## Requirements

- Linux, Node.js 24 or later (the version in `.nvmrc`), npm 11, and `jq` for the unit tests
- Firefox 153 or later for running the extension

## Setup

```sh
npm ci
npm run prepare
```

`npm ci` runs no install scripts (see [Dependency updates](#dependency-updates)), so it does
not install the Git hooks. `npm run prepare` does: the pre-commit hook formats and lints staged
files with Biome, and the pre-push hook runs the type check and the unit tests. Run
`npm run prepare` again after husky is updated, to refresh the hooks.

## Layout

The repository is an npm workspaces monorepo run by Turborepo:

- `apps/extension/`: the Firefox extension
- `apps/server/`: the `foxleash` command (MCP server, native host, installer)
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

CI (`.github/workflows/ci.yml`) runs them on pushes to `main` and `gate/**` branches, on pull
requests and on demand. A push to `main` of a commit whose CI already passed on a `gate/`
branch skips them: a first job finds that green run, and the run passes without testing again.
The test-integrity check compares a pull request with its base branch, and every other run with
the nearest commit in its history, in topological order, whose successful CI run ran this check
(read from the GitHub API), or with a start commit pinned in `bin/ci-integrity-base.ts`, so a
cancelled run or a `gate/` branch's first push leaves no commit unchecked. The start commit counts
even when it is outside the newest 100 successful runs. The step fails when it cannot read the
runs or the history, and when HEAD's history holds neither a recognised run among the newest 100
nor that commit. A merge of two lines that each passed CI since they forked is compared with only
one of them: the one topological order lists first.

`npm test` also checks the architecture decision records: that every `ADR NNNN` reference
names a record that exists, that links and written-out paths into `docs/adr/` and
`docs/measurements/` name files that exist, that every record has a row in
`docs/adr/README.md`, and that the numbers of merged records are not used again.

It checks the workflows in `.github/workflows/` too: each sets its token's permissions at the
top level, as `permissions: {}` or a block of scopes, and names its actions by commit (see
[Dependency updates](#dependency-updates)). In `ci.yml` that block is exactly `contents: read`;
a job that needs more lists every scope it needs in a block of its own, which replaces the
top-level one. In `publish.yml` only the job that runs no project code holds the identity token,
and the tests run its checks against crafted tarballs and AMO answers (see
[npm package](#npm-package)).

The test scripts, `npm run e2e` included, use `bin/test-reporter.ts`: a passing run prints a
line of counts (and, where coverage is measured, a line of coverage totals), a failing test is
printed in full with the output the tests wrote, and a missed coverage floor prints the
per-file coverage table. Every run also prints the diagnostics tests report with
`t.diagnostic` (the end-to-end tests use them for timings); one from a test inside a
`describe` or another test starts with its test file's name. A run ended by SIGINT or SIGTERM
(Ctrl-C, or CI's time limit) prints each test file that was running with the test that was
running in it, or the test after which its hooks or teardown were running, then the failures
so far. Set `FOXLEASH_TEST_REPORTER=spec` (or any other `--test-reporter` value) for Node's
per-test output, for example `FOXLEASH_TEST_REPORTER=spec npm test`.

In a checkout the server's TypeScript runs directly on Node (type stripping); `npm run build`
also bundles it with `apps/server/build.ts` into `apps/server/dist`, the
[npm package](#npm-package). Running Node with `--preserve-symlinks` breaks this for the
workspace packages: Node refuses to strip types from files it sees under `node_modules`.

## End-to-end tests

`npm run e2e` builds the extension, then starts a pinned Firefox headless with a temporary
home directory and a temporary `XDG_RUNTIME_DIR`, so it never touches your own Firefox or
Foxleash. It installs the native host into that home, installs the extension over WebDriver
BiDi, serves fixture pages from a local HTTP server, and calls the real MCP tools through
`foxleash mcp`, as an MCP client would.

The suite runs on linux x64 only, on two pinned Firefox versions: the current release,
pinned in `bin/firefox-version.json`, and the ESR, pinned in `bin/firefox-esr-version.json`.
The first run on each downloads it into `${XDG_CACHE_HOME:-~/.cache}/foxleash-firefox` and
checks it against its pin's sha256; later runs reuse it. `npm run e2e` runs the suite on the
release, and `FOXLEASH_E2E_FIREFOX=esr npm run e2e` on the ESR. Unset, empty or `release`
selects the release; any other value stops the run.

To raise the release pin, set the new version in `bin/firefox-version.json` together with the
sha256 of `linux-x86_64/en-US/firefox-<version>.tar.xz` from Mozilla's
`https://archive.mozilla.org/pub/firefox/releases/<version>/SHA256SUMS`. Raise the ESR pin in
`bin/firefox-esr-version.json` the same way, under its `<version>esr` name: for example
`releases/153.8.0esr/SHA256SUMS` and `firefox-153.8.0esr.tar.xz`. When Mozilla's current ESR
(`FIREFOX_ESR` in `https://product-details.mozilla.org/1.0/firefox_versions.json`) moves to
the next ESR major, the ESR pin moves to it, and a unit test in `bin/install-firefox.test.ts`
then requires the extension's minimum Firefox version (`strict_min_version` in
`apps/extension/manifest.json`) to move to the same major version (ADR 0077). Each raise is a change of its own (see ADR 0003
and ADR 0076), and also updates the exact version and sha256 in that pin's test in
`bin/install-firefox.test.ts`, "ships a pin that validates" or "ships an ESR pin that
validates".

`FOXLEASH_E2E_SHARD=<index>/<total> npm run e2e`, for example `FOXLEASH_E2E_SHARD=2/3`, runs
only that shard of the test files. `bin/e2e-shard.ts` deals them out by measured duration:
the longest file first, each to the shard with the least measured time so far. The durations
are the seconds in `bin/e2e-durations.json`; a file without an entry there counts as the mean
of the entries. CI runs the suite on both pins, as three shards each, in six parallel jobs.
Each job's end-to-end step stops itself after 15 minutes, inside the job's 20-minute limit, so
a hung run ends with the report above of what was running. The shard must go through the
variable: `npm run e2e -- --test-shard=2/3` puts the flag after the test files, where Node
reads it as one more pattern and runs every file.

To refresh the durations, run the suite with the durations reporter:
`FOXLEASH_TEST_REPORTER=./bin/e2e-durations-reporter.ts npm run e2e`.
It writes `bin/e2e-durations.json`, and drops the entries of test files that no longer exist.
With `FOXLEASH_E2E_SHARD` set it measures that shard's files only and keeps the other entries.
A run with a failed test writes nothing; run the suite again with the normal reporter to see
which test failed. Refresh after adding a long test file, or when the slowest shard's CI step
on a pin takes more than about 15% longer than the mean of that pin's three steps. A refresh
cannot bring a shard below the mean: when the mean nears 60% of the 15-minute limit (540
seconds), the remedy is more shards, which amends
[ADR 0076](adr/0076-e2e-tests-run-on-the-current-firefox-release-and-the-esr.md).

The tests also act in the extension's own pages, which WebDriver reaches only with system
access, so the test Firefox starts with `--marionette` and `--remote-allow-system-access`
(see [ADR 0008](adr/0008-e2e-tests-act-in-extension-pages-through-bidi-and-marionette.md)),
and with `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` in its environment, which Firefox 159 and later
require.
The harness opens the session over Marionette (`WebDriver:NewSession` with
`webSocketUrl: true`) and connects BiDi to the WebSocket URL it returns. BiDi installs the
extension, opens, navigates and closes tabs and evaluates script in them; Marionette only
clicks (`WebDriver:FindElement` and `WebDriver:ElementClick`), sends input actions
(`WebDriver:PerformActions`: the mouse press and release of `firefox.press` and
`firefox.release`, and the keys `firefox.keys` presses) and brings a tab to the front
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
After a restart the test connects a new MCP session: sessions end with the Firefox that quit.
The extension's `storage.local`, and so the settings, carries over the restart, though the add-on
is installed again (measured, ADR 0081); `e2e/foreign-file-restart.test.ts` depends on that.

A test that needs Firefox to withhold Foxleash's access to websites starts it with
`harness.startFirefox(EXTENSION_DIST, { withholdSiteAccess: true })`, which sets
`extensions.originControls.grantByDefault` to `false`, so Firefox installs the add-on with its
optional access off, as when the user turned off "Access your data for all websites" in
about:addons. It also sets `extensions.webextOptionalPermissionPrompts` to `false`, so Firefox
grants `permissions.request` without its prompt, which WebDriver cannot answer; a test can then
give the access back with a click on the settings page's button. A request still needs the
user's input, such as `firefox.click`. `e2e/site-access-withheld.test.ts` starts Firefox this way.

A test that reloads the extension, as `browser.runtime.reload()` does, calls
`harness.reloadExtension()`. It evaluates the reload in the settings page, waits until Firefox
has closed that page with the old add-on, then until a settings page it opens shows the reloaded
add-on's title, and closes it. A reload opens no page, unlike an install.

The approval prompt's buttons answer only a second after its page is both visible and
focused, so `harness.waitForArmed` first brings the prompt's tab to the front with
`firefox.activate`, which sends the same Marionette `WebDriver:SwitchToWindow` that
`firefox.click` sends before it clicks, so a click right after it changes neither focus nor
visibility. Tests answer the prompt only with real (trusted) input, `firefox.click` or the
keys `firefox.keys` presses: a click from script is not trusted, and the prompt ignores it.
After a lone Alt, F10, the Menu key, a key pressed with Alt (such as Alt+V), a right-button press,
a `contextmenu` event, or an Alt keyup the page did not see go down, the buttons stay unarmed until
the page sees a click, or a key at least `HOLD_JOIN_MS` (100 ms) later, so a test that sends one
clicks, or waits that long and presses a key, before it waits for them.

## Extension

`npm run build` bundles the extension into `apps/extension/dist/`: the manifest with the
version from `apps/extension/package.json`, unminified `background.js`, `options.js`,
`welcome.js`, `approve.js`, `propose.js`, `run.js` and `content.js`, the script Foxleash injects
into the pages of the agent's tabs, the settings page `options.html`, the welcome page
`welcome.html`, which opens when the extension is installed, the approval prompt
`approve.html`, the recipe page `propose.html` and `run.html`, the page where the user allows a
recipe's sites, or the sites an agent asks for, for a session, with their shared `pages.css`,
and the icon. It then lints that
folder with web-ext, ignoring web-ext's `WEB_EXT` environment variables and config files, and
fails on any error or warning.

`npm run dev` rebuilds `background.js`, `options.js`, `welcome.js`, `approve.js`, `propose.js`,
`run.js` and `content.js` whenever their TypeScript source changes and runs Firefox through
`web-ext run`, which reloads the extension after each rebuild. It writes the manifest, the icon
and the pages (`src/*.html` and `src/*.css`) once at start, so restart it after changing them.
Firefox uses a persistent profile in `$XDG_CACHE_HOME/foxleash/dev-profile` (by default
`~/.cache/foxleash/dev-profile`), so what you set up there, such as logins, stays between
runs. It needs a desktop with Firefox 153 or later.

## AMO source archive

Mozilla reviewers rebuild the extension from a source archive. `npm run build:amo` builds
`artifacts/foxleash-source-<version>.zip` from HEAD's commit: it copies the shipped files and
the README template from that commit, not from the working tree or the git index, so
uncommitted changes, staged or not, are not in the archive. It then extracts the archive into
a temporary directory and runs `npm ci && npm run build` there, as a reviewer would. The
archive ships `.npmrc`, so that `npm ci` runs no install scripts. From that clean copy it
builds `artifacts/foxleash-<version>.xpi`. It fails unless:

- every file in the commit matches a ship or exclude rule in `bin/build-amo.ts`;
- every shipped path is a plain relative name: letters, digits, `.`, `_`, `-` and `/`, with
  no `.`, `..` or empty segment;
- the archive's files are exactly the ones in `bin/amo-source-files.txt`, read from the same
  commit;
- no symlink or submodule in the commit sits at or above a shipped path;
- no `node_modules` folder sits above the temporary directory, where the clean build could
  load packages a reviewer does not have;
- the clean rebuild is identical to the normal build in `apps/extension/dist/`, which builds
  the working tree: a working tree that builds differently from HEAD fails here.

After the comparison it prints `Extension files digest at <commit>: sha256:<64 hex> (<n> files)`,
with HEAD's full commit. The digest is the sha256 of one line per regular file of the clean
copy's `apps/extension/dist/`, the files the XPI holds: the sha256 hex of the file's bytes, two
spaces, the path relative to that folder with `/` between its parts, and a newline, as
`sha256sum` prints it, with the lines in byte order of the path (`LC_ALL=C sort`). It covers the
files' names and bytes, not zip metadata, so another machine that builds the same files prints
the same value. CI's `validate` job runs `build:amo`, so its log carries the digest, and
`check:release -- built` compares it with the XPI (see [Release checks](#release-checks)).

The two files appear in `artifacts/` only when every check passes, and they are moved there
together, so a second run at the same time cannot leave one run's archive beside the other's
XPI.

The archive ships `bin/amo-source-readme.md` as its `README.md`, with the exact Node and npm
versions of the build filled in. The command needs `git`, `zip`, `unzip`, `diff` and network
access for `npm ci`.

When you add, move or delete a file that the extension build reads, edit
`bin/amo-source-files.txt` and commit it in the same commit, one path per line in
`LC_ALL=C sort` order. When the command reports a tracked file it cannot classify, add a ship
or exclude rule for it in `bin/build-amo.ts`.

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
  listing, and every bullet of the capability list has a capability claim and every bullet of
  the safeguard list and of the Description's first-screen list of protections ("What
  protects you:") a safeguard claim; the tools the server registers are exactly the claimed
  ones; each safeguard's evidence holds (a tracked file contains, or lacks, a string), and a
  safeguard with no evidence fails, because it is not built yet; every permission and data
  collection category in the manifest is explained in the listing, and every permission the
  listing explains is in the manifest; the categories are matched in the list after "The
  extension declares these kinds of data to Firefox:" in the Data collection and handling
  section, which must name, as `(name)`, each category the manifest declares and no other of
  Mozilla's categories; the Summary, the Description and the Permissions section, which go
  to AMO as the add-on's summary and description and as each version's notes to reviewers,
  hold at most the 250, 15,000 and 3,000 characters AMO takes for them.
  With a previous tag, it prints the diffs of the manifest, the listing and
  `bin/amo-source-files.txt` between that tag and the working tree, and fails when the
  manifest's permissions, content script matches, data declarations, `web_accessible_resources`,
  `externally_connectable` or `content_security_policy` changed but none of the listing's
  Summary, Description, Permissions and Data collection and handling sections (the text that
  goes to AMO as fields, notes to reviewers and privacy policy) did. A change elsewhere in the
  listing (its preface, Name, Compatibility or Screenshots) does not count. It also fails when
  the tag's listing cannot be read or lacks one of those sections.
- `protocol`: the extension still serves the server of the latest release (see
  [Protocol versions](#protocol-versions)). It reads `PROTOCOL_VERSION` and
  `OLDEST_SERVED_PROTOCOL` from `packages/protocol/src/index.ts` in the working tree and
  `PROTOCOL_VERSION` from the same file at the latest tag, and prints the three numbers. It fails
  when a constant cannot be read, when `OLDEST_SERVED_PROTOCOL` is above `PROTOCOL_VERSION`, when
  `PROTOCOL_VERSION` is below the tag's, and when `OLDEST_SERVED_PROTOCOL` is above the tag's.
  Without a previous tag it skips the comparison with a release and says so. When
  `OLDEST_SERVED_PROTOCOL` is above the oldest protocol the latest tag serves (that tag's
  `OLDEST_SERVED_PROTOCOL`, or its `PROTOCOL_VERSION` when it has none), it reads npm's publish
  times with `npm view foxleash time --json`, prints the newest tagged release npm published at
  least 14 days earlier, and fails when `OLDEST_SERVED_PROTOCOL` is above that release's
  `PROTOCOL_VERSION`, when there is no such release, or when the npm call fails or prints no
  usable times. It queries npm only when the window moved, so an ordinary CI run makes no network
  request.
- `pre-roll [--bump=patch|minor|major]`: the changelog shape; HEAD is `main`, equal to
  origin's `main`, with a clean working tree; every version field agrees; the latest tag is
  on origin; Unreleased has entries; the bump is at least what the change types need
  (`Removed` major, `Added` or `Deprecated` minor, else patch; before 1.0.0 a major change
  needs only minor); the next tag exists neither here nor on origin; and the newest CI run of
  `ci.yml` on `main` for HEAD succeeded. It also runs the `listing` and `protocol` checks. The
  first release takes no `--bump`; every later one needs it.
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
  that version. The XPI's manifest has `<version>`, and the source archive holds exactly the
  files the tagged commit ships (by the rules of `bin/build-amo.ts`, which must agree with
  the tag's `bin/amo-source-files.txt`), byte for byte, and a `README.md` that is the tag's
  `bin/amo-source-readme.md` with some Node and npm versions filled in.
- `built <version> [--dir <path>]`: the artifact checks of `pre-push`, and a comparison of
  the XPI with CI's build, for `foxleash-<version>.xpi` and `foxleash-source-<version>.zip` in
  `<path>` (default `artifacts`, relative to the repository root), against the commit of the
  tag `v<version>`, which must exist. It computes the digest `build:amo` prints (see
  [AMO source archive](#amo-source-archive)) over the XPI's file entries, prints it, and
  compares it with the digest the `validate` job printed for the tag's commit in each
  successful run of `ci.yml` on `main` for that commit. It fails when one differs, when no
  successful `validate` job printed one, and when a `gh` call fails, so it needs an
  authenticated `gh` and network access. A log GitHub no longer keeps comes back with
  `gh run rerun <run id>`, which GitHub allows only within 30 days of the run; after that the
  version needs a new release. It judges the tag's tree by the ship rules of the checkout it
  runs in and fails where they disagree with the tag's `bin/amo-source-files.txt`, so a
  checkout whose rules changed since the tag fails rather than passes.
- `artifacts <version> [--unsigned <path>]`: the signed XPI in `web-ext-artifacts/` holds the
  signature files and exactly the files of the unsigned XPI (default
  `artifacts/foxleash-<version>.xpi`), byte for byte except `manifest.json`, which may differ
  only in its JSON formatting (AMO's signed copy drops the final newline), and its manifest
  has `<version>`.
- `tag <tag>`: the tag is `v` and an `x.y.z` version, that version is the version of every
  version field, HEAD is the tag's commit (an annotated tag is peeled to its commit), and that
  commit is on origin's `main`, which it fetches first. It does not require an annotated tag:
  `actions/checkout` can turn the tag it checks out into a lightweight one, and `pre-push` has
  already checked the annotation before the push.

`pre-roll` and `pre-push` also run `npm audit` on `package-lock.json`, development packages
included, and fail on each advisory of high or critical severity and when the audit cannot
run; lower advisories print as `INFO:` lines.

The version fields are the root and workspace `package.json` files and `package-lock.json`.
The extension's built manifest takes its version from `apps/extension/package.json`; the
source `apps/extension/manifest.json` has no `version`.

The exit status is 0 when every check passes, 1 when one fails, 2 on a usage error, and 3
when nothing fails but a warning (such as a bigger bump than the changes need, or a
breaking change mentioned in a smaller bump) needs your confirmation. CI runs the
`changelog`, `listing` and `protocol` checks, and the publish workflow runs `tag` (see
[npm package](#npm-package)).

## Protocol versions

`PROTOCOL_VERSION` in `packages/protocol/src/index.ts` is raised when a message shape or a
method contract changes incompatibly: a param that changes its meaning or default, a new param an
older extension would not honour, a result key an older server needs and no longer gets, a
renamed or removed method.

Firefox updates the extension by itself, so the extension serves every protocol from
`OLDEST_SERVED_PROTOCOL` up to `PROTOCOL_VERSION` and answers each request in the protocol of the
native host it came from (ADR 0072). A host or `doctor` refuses only an extension older than
itself; the MCP server and the host stay exact with each other.

The commit that raises `PROTOCOL_VERSION` adds a step for the version it leaves behind to `STEPS`
in `apps/extension/src/served-protocols.ts`. The step owes either the rewrite of the old shape (a
request of its version into one of the next, a result of the next back into one of its version)
with a test through the real handler, or a comment saying why nothing differs. A step changes
shape only: when it cannot serve the old shape without relaxing a safeguard, it refuses the
request with a `ToolError`. The unit test in `served-protocols.test.ts` fails until each version
in the window has its step.

`OLDEST_SERVED_PROTOCOL` is never above the `PROTOCOL_VERSION` of the newest release npm has
served for 14 days, and so never above the latest release's: a user with an npm release-age limit
gets the newest release older than the limit from `npx foxleash@latest setup`, so the extension
keeps serving what such a user still gets, for limits up to 14 days.
`npm run check:release -- protocol` checks it, in CI and in `pre-roll`. It may be raised to that
number, and the steps below it are then deleted. Programs from before ADR 0072
(protocol 3 to 5) check the protocol exactly and refuse a newer extension, so the window serves
programs from the first release that carries it on.

A release publishes its add-on before its server: a server refuses an add-on older than itself,
so its program is made available only once its add-on version can be installed. The workflow
that publishes the npm package checks that AMO serves the version first (see
[npm package](#npm-package)). Publishing to npm early is no way out of the 14-day rule, for the
same reason (ADR 0072).

## Releasing

A release starts from `main`; its commits are made on a `release/x.y.z` branch and reach
`main` only through the push. It runs the release checks in this order: `pre-roll`,
`post-roll <version>`, `post-bump <version>`, `pre-push`, `built <version>`,
`artifacts <version>`. What each one verifies is in [Release checks](#release-checks), as are
the version fields: the root and workspace `package.json` files and `package-lock.json`, with
the extension's manifest taking its version from `apps/extension/package.json`.

The signed add-on and the source archive are the bytes of the tagged commit. `build:amo`
copies the shipped files from HEAD's commit and builds the XPI from that archive, failing
when the checkout's build differs, and `pre-push` and `built` compare the archive with the
tagged commit (ADR 0075). `built` also compares the XPI's files with CI's build of that commit.

1. Run `npm run check:release -- pre-roll --bump=<patch|minor|major>`. It prints the next
   version, `x.y.z` below. The first release, 0.1.0, runs `pre-roll` without `--bump`.
   Then check that the address the program prints for the add-on (`ADDON_PAGE_URL`) is this
   add-on's page on Firefox Add-ons, by its slug there or by its add-on id, and stop when it
   is not.
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
   builds `artifacts/foxleash-source-x.y.z.zip` and `artifacts/foxleash-x.y.z.xpi` from
   HEAD's commit, so commit everything first.
5. Create the annotated tag with `git tag -a vx.y.z -m "vx.y.z"` and run
   `npm run check:release -- pre-push`. Then check that every entry of
   `artifacts/foxleash-x.y.z.xpi` survives the trip to `web-ext sign`: none that web-ext's
   default ignores would leave out (a path component that starts with `.`, is
   `node_modules`, or ends in `.xpi` or `.zip`) and none the `artifacts` check refuses as
   unsafe. On a match, stop before pushing: the tag is still local, so deleting it and the
   release branch undoes the release, and the fix is a build change. Otherwise push the
   release branch to origin's `main` and the tag together with
   `git push --atomic --no-follow-tags origin refs/heads/release/x.y.z:refs/heads/main refs/tags/vx.y.z`.
   Then move local `main` to the pushed commit with `git switch main`,
   `git merge --ff-only release/x.y.z` and `git branch -d release/x.y.z`.
6. Once CI has passed on the pushed commit, sign the XPI from the clean copy,
   `artifacts/foxleash-x.y.z.xpi`, as a listed version on addons.mozilla.org (ADR 0105).
   First run `npm run check:release -- built x.y.z` (with `--dir <path>` when you sign copies
   kept elsewhere, and then take both files below from that folder) and stop on a failure.
   `built` also compares the XPI's files with CI's build of the tagged commit. When the
   digests differ, do not sign: this machine built another extension than CI did, and the fix
   is a build change, not a looser check.
   `web-ext sign` takes a directory, so extract the XPI and pass that directory as
   `--source-dir`. Before extracting, check the entry names again as in step 5. Then extract
   it, stop on any unzip warning, and check that the folder holds exactly the XPI's files, as
   regular files (web-ext follows a symbolic link).
   Each release sets the add-on's summary, description, privacy policy, category, homepage,
   support site and support email on AMO from `docs/amo/listing.md` at the tag, changing only
   what differs, before it submits the version: AMO takes a listed version only when the add-on
   has a name, a summary and categories, and Mozilla reviews each version against the whole
   listing. It also sets the add-on's screenshots, their captions and its icon on AMO from
   `docs/amo/` at the tag before it submits the version.
   Run `web-ext sign` with `--channel listed`, with `WEB_EXT_API_KEY` and
   `WEB_EXT_API_SECRET` (an AMO API key pair) in the environment, with the source archive
   attached by `--upload-source-code artifacts/foxleash-source-x.y.z.zip`, and with
   `--amo-metadata` naming a JSON file whose `version` object carries
   `"compatibility": ["firefox"]`, `approval_notes` and the license. The approval notes are the
   body of the Permissions section of `docs/amo/listing.md`, which goes with every version; the
   compatibility follows its Compatibility section and the license its Listing details
   section: `"license": "<slug>"` for a license on AMO's list, otherwise
   `"custom_license": { "name": { "en-US": "<name>" }, "text": { "en-US": "<text>" } }` with
   the custom license name and text given there, never both.
   A listed version can wait for Mozilla's review, and web-ext's wait can end before the review
   does: web-ext then reports `Approval: timeout exceeded`, and the version's file has the
   status `unreviewed` on AMO. Fetch the signed file once AMO has approved it (its status is
   then `public`); steps 7 and 8 follow.
7. Put the signed XPI in `web-ext-artifacts/foxleash-x.y.z.xpi` and run
   `npm run check:release -- artifacts x.y.z`.
8. Create a draft GitHub release for the tag `vx.y.z` with `foxleash-x.y.z.xpi` attached,
   review it and publish it. Publishing it starts the publish workflow, which publishes the npm
   package of that version (see [npm package](#npm-package)).

### AMO screenshots

A listed release takes its screenshots from `docs/amo/screenshots/`, with the captions in
`docs/amo/listing.md`: the approval prompt with its buttons armed, the orange Foxleash tab
group with an OpenStreetMap page the agent opened, and the settings page. Retake them, and
look at them, when the UI a shot shows changes before a listed release.

`npm run screenshots:amo` builds the extension and takes them through the end-to-end harness,
in a headed Firefox (the end-to-end pin) with a throwaway profile. It sizes the window to the
screen, hides the marks Firefox puts on a window WebDriver controls, and overwrites the three
files in `docs/amo/screenshots/`. It needs `xvfb-run`, `ffmpeg` and access to
openstreetmap.org:

```sh
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24' npm run screenshots:amo
```

The add-on's icon on AMO, `docs/amo/icon-128.png`, is rendered from
`apps/extension/icons/foxleash.svg`. Render it again whenever the SVG changes, with an `ffmpeg`
built with librsvg, from the repository root:

```sh
ffmpeg -hide_banner -loglevel error -y -width 128 -height 128 -i apps/extension/icons/foxleash.svg -frames:v 1 docs/amo/icon-128.png
```

## Server

Each subcommand runs as `node apps/server/src/main.ts <subcommand>`; `--help` lists them.

The `setup` subcommand (`npm run setup` in a checkout, `npx foxleash setup` from the npm
package; `install` is another name for it) writes the launcher to
`~/.local/share/foxleash/foxleash-host` and the native manifest to
`~/.mozilla/native-messaging-hosts/foxleash.json`; both paths derive from `$HOME` only. The
program it points the launcher and Claude Code at depends on the file the command runs from:

- From the TypeScript source (a checkout), it is this checkout's `main.ts`, so rerun setup
  after moving or switching checkouts.
- From the bundle (npx, or the installed copy itself), setup first copies the bundle to
  `~/.local/share/foxleash/foxleash.mjs`, so the program does not live in npm's cache, which
  npm may clear. It writes the bytes at mode 0600 under a new random name in that folder (an
  exclusive create, which never follows a symlink), then renames the file onto
  `foxleash.mjs`, so a host Firefox starts meanwhile runs the old file or the new one. A
  failed copy leaves the launcher, the manifest and the registration as they were.

The launcher names the absolute path of the Node that ran setup, so rerun setup after
switching Node versions. Setup then prints the stdio server for other MCP clients as one line
of JSON, `{"mcpServers":{"foxleash":{"command":"<node>","args":["<program>","mcp"]}}}`, unless
the Claude Code registration failed, and ends with the doctor command of its route. It never
runs doctor itself. `--no-claude` on setup and on uninstall (`npm run teardown -- --no-claude`
in a checkout) leaves Claude Code's user configuration unchanged. Uninstall removes the
manifest, the launcher and the copy, then their folder when it is empty.

Setup's last step names the add-on's page on Firefox Add-ons (`ADDON_PAGE_URL` in
`packages/protocol`); setup makes no network request. `--xpi <path>` opens a local file in
Firefox instead, which asks you to confirm the installation; under `npm run setup` a relative
path resolves against the directory `npm run` was started from, otherwise against the current
directory. `--no-extension` skips the step. Firefox is started detached, so setup neither waits
for it nor stops it.

The host listens on `<socket directory>/<pid>.sock`. The socket directory is the first of
`$XDG_RUNTIME_DIR/foxleash` and `/run/user/<uid>/foxleash` whose base directory (that is,
`$XDG_RUNTIME_DIR` or `/run/user/<uid>`) is a real directory owned by you with no group or
other permission bits, else `/tmp/foxleash-<uid>`.

Foxleash creates the socket directory with mode 0700. It refuses one that is a symlink, belongs
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
server then falls back to `/run/user/<uid>/foxleash`, the running user's real Firefox.

`npm run doctor` (the `doctor` subcommand) changes nothing in your setup. It reads the native
manifest and checks its name, type, allowed extension and launcher path. It runs the launcher
the way Firefox does, but with only `HOME`, `PATH=/usr/bin:/bin` and a private temporary
`XDG_RUNTIME_DIR` in its environment, so the host it starts never joins the real socket
directory: it sends one extension hello, expects a welcome, ends stdin and expects a clean
exit, then removes the temporary directory. It runs `claude mcp get foxleash` and compares the
registered command with the program of its route, as setup picks it; its hints name that
route's setup command. It checks the socket directory with the same rules as the host, and
makes one `mcp` hello and welcome round trip over each socket of a running process, reading the
extension's state from the welcome. The extension reports its access to all websites when it
connects to the host and again whenever the user grants or revokes it, so that line shows the
current state. When the extension's version differs from its host's on protocols that work
together, doctor warns and names the older part and its update; the host and the extension log
the same sentence, and nothing is refused for it. When the socket directory does not exist or
no host answered, and `~/.var/app/org.mozilla.firefox` is a folder, doctor prints the
`about:config` step for Firefox from Flatpak under that FAIL line.

### npm package

`npm run build -w @foxleash/server` runs `apps/server/build.ts`, which writes the package
`foxleash` into `apps/server/dist`, starting from an empty folder:

- `foxleash.mjs`: `src/main.ts` and everything it imports, bundled by esbuild into one
  unminified ES module for Node 24 that starts with `#!/usr/bin/env node`. Node refuses to strip
  types under `node_modules`, so the TypeScript source cannot ship as it is. The version is
  `apps/server/package.json`'s, inlined at build time.
- `package.json`: the name, version, description, license, the `foxleash` bin entry, `engines`,
  `os` and the repository, with no dependencies and no scripts, so npx installs nothing else.
- `LICENSE` and `README.md`, copied from the repository root.
- `THIRD_PARTY_NOTICES.md`: each package under `node_modules` whose code the bundle contains
  (read from esbuild's metafile), with its version, its license and the text of its license
  and NOTICE files.

The build fails before it writes anything, naming the file or the package, when a bundled file
is neither in a package under `node_modules` nor in `apps/server/` or `packages/`, when a
package's `license` is not exactly one of MIT, ISC, BSD-2-Clause, BSD-3-Clause and Apache-2.0
(an SPDX expression or a `licenses` array fails too), when it has no license file (`LICENSE` or
`LICENCE`, bare or with `.md` or `.txt`, in any case), or when a license or NOTICE file is empty
or not a regular file.

The workspace `@foxleash/server` stays private; only the generated folder is published. GitHub
Actions publishes it (`.github/workflows/publish.yml`, ADR 0106) when a GitHub release is
published, step 8 of [Releasing](#releasing), so nobody runs an npm command for a release. The
workflow has no other trigger and two jobs:

- `build`, whose token may only read the repository, checks out the tagged commit with its
  history, runs `npm ci` and then `npm run check:release -- tag <tag>` (see
  [Release checks](#release-checks)): the tag is `v` and the version of every version field,
  HEAD is its commit, and that commit is on origin's `main`. It then asks AMO's public API,
  without credentials, every minute for up to 30 minutes whether AMO serves that version as a
  public, listed version, and fails when it does not (see [Protocol versions](#protocol-versions)).
  It runs `npm run lint`, `npm run typecheck` and `npm test`, then
  `npm run build -w @foxleash/server`, which runs `build.ts` itself: turbo's cached `build` keys
  on `apps/server`'s files only, so a change to the root `README.md`, `LICENSE` or description
  alone could restore an old `dist`. It packs `apps/server/dist` with `npm pack` and refuses the
  result unless it is exactly one file, `foxleash-<version>.tgz`, holding exactly the five files
  above, each once and each a regular file. The tarball is kept as an artifact of the run for one
  day.
- `publish` runs after `build`, in the GitHub environment `npm`, and is the only job that gets
  the identity token that npm's trusted publishing takes instead of a stored token. It runs no
  project code: no checkout, no install, no npm script. It refuses an npm older than 11.5.1, the
  first with trusted publishing; a build version that is not `x.y.z` or whose `v` form is not the
  release's tag; and the downloaded tarball unless it passes the same checks as in `build`. It
  unpacks the five files and refuses a `package.json` that is not exactly one JSON object with
  the name `foxleash` and the tag's version, or that has a `publishConfig` or `scripts`. GNU tar
  and npm can read one archive differently, so it then packs the checked files again with
  `npm pack`, checks that tarball the same way, and publishes it with
  `npm publish --provenance --access public`.

No npm token is stored anywhere. On npmjs.com the package `foxleash` has a trusted publisher:
GitHub Actions in this repository, the workflow file `publish.yml` and the environment `npm`,
allowed to run `npm publish` but not `npm dist-tag`. The environment allows only tags that match
`v*` to use it. The package's publishing access requires two-factor authentication and refuses
tokens, so a version comes from the workflow or from a maintainer publishing with two-factor
authentication. npm attaches provenance that links each version to the commit and the workflow
run that built it.

A failed run is re-run from the repository's Actions page with "Re-run all jobs", which replays
the same release event; the build's artifact is kept for one day. When AMO did not serve the
version within the 30 minutes, re-run it once AMO does. A version npm already has fails to
publish: npm refuses to publish a version twice.

## Probing synthetic input

`npm run probe -- <url>...` (the `probe` subcommand) measures which kinds of synthetic input
work on real pages, to tune how Foxleash clicks and types. With Firefox running and the
extension connected, it opens each URL in a new tab in the probe's own Foxleash tab group.
When Firefox asks in that tab whether to allow the site, answer there; the probe waits up to
10 minutes per URL. It then runs a fixed check bundled in the extension in the page and moves
on to the next URL.

It writes two reports, `<path>.json` and `<path>.md`, and never replaces an existing file.
`--out <path>` sets the path without its extension; by default it is
`foxleash-probe-<date>-<time>` in the current folder. Through npm, the current folder and so a
relative `--out` path are the Foxleash folder.

What the probe does in a page:

- It types short markers such as `fxsetter` into the first text field (never a password field,
  nor one marked for a password or a one-time code, nor one Firefox filled in), the first
  editable area and the first rich editor (such as Gmail's compose window or a Google Docs
  document) it finds. It restores a text field's value afterwards, but not an editor's text, so
  run it on a scratch document or a draft. The page reacts to the markers as it would to your
  typing, for example by searching for them.
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
3. Run `npm run probe -- <url>...` and allow each site in its tab when Foxleash asks.

## Dependency updates

Dependabot opens pull requests every Thursday: npm updates grouped into one for development
and one for production dependencies, and one per GitHub Action. It proposes a new release only
once it is 3 days old; security updates skip that wait. The `Auto-merge Dependabot` workflow
squash-merges such a pull request once CI and all of its checks pass; one that fails stays open
for a person to fix. A pull request whose branch moved after its checks ran is not merged on
those checks; the CI run for its new head merges it. When GitHub refuses the merge while the
pull request is still open on the checked commit, as when another merge moves `main` at the same
moment, or the workflow then cannot read the pull request's state, the merge is tried twice more,
15 seconds apart. After merging, the workflow starts CI on `main`
itself, because a merge made with its own token starts no push run, and retries starting it the
same way. The CI run it starts tests the updates merged together.

The workflows name each action by the commit its release tag points to, with that tag in a
comment (`actions/checkout@<commit> # v7.0.1`), and Dependabot's updates change both; a unit
test fails on an action named any other way, a tag or a local action (`./...`) included. The
test checks the form only, not that the commit is the one the tag names. The pin keeps a moved
tag from changing what CI runs, but it does not vet a new release: Dependabot still proposes it
after the 3-day wait, and it is merged on the checks like any other update.

Updates are merged without a person reading them because the checks are the gate: CI,
including the end-to-end suite, runs on every Dependabot pull request, and an update that
breaks something yet passes the checks shows a missing test to add. The 3-day wait skips
releases younger than 3 days and proposes the newest release that is older, so a package that
releases often still gets updated.

Because updates are merged unread, the repository's `.npmrc` sets `ignore-scripts=true`: a
dependency's install script would otherwise run at the next `npm ci` on every machine,
including the one that signs releases. Today one dependency, esbuild, has an install script,
and the build does not need it. The setting also makes npm skip `pre` and `post` scripts and
lifecycle scripts such as `prepare`, so a step goes in the script that needs it instead; a unit
test fails on any such script other than the root `prepare`, which Setup runs by name.

When a future dependency really needs its install script, read the script, then run that one
package's scripts by hand after `npm ci` with `npm rebuild <package> --ignore-scripts=false`,
which runs no other package's scripts and not the repository's `prepare`. Never turn
`ignore-scripts` off for the repository. Running it by hand fixes only the machine it is typed
on: when the build or the program needs the script, the same command goes after every `npm ci`
that needs it (CI, `bin/build-amo.ts` and the archive's README, the users' update command), as
a recorded decision.
