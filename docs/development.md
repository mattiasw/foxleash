# Development

## Requirements

- Linux, Node.js 24 or later (the version in `.nvmrc`), npm 11
- Firefox 140 or later for running the extension

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

## Extension

`npm run build` bundles the extension into `apps/extension/dist/`: the manifest with the
version from `apps/extension/package.json`, an unminified `background.js`, and the icon. It
then lints that folder with web-ext, ignoring web-ext's `WEB_EXT` environment variables and
config files, and fails on any error or warning except the one expected Firefox for Android
warning on `data_collection_permissions`. See
[ADR 0006](adr/0006-no-firefox-for-android-key-in-the-manifest.md) for why.

`npm run dev` rebuilds `background.js` whenever its TypeScript source changes and runs Firefox
through `web-ext run`, which reloads the extension after each rebuild. It writes the manifest
and the icon once at start, so restart it after changing them. Firefox uses a persistent
profile in `$XDG_CACHE_HOME/foxhand/dev-profile` (by default
`~/.cache/foxhand/dev-profile`), so what you set up there, such as logins, stays between
runs. It needs a desktop with Firefox 140 or later.

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

## Server

Each subcommand runs as `node apps/server/src/main.ts <subcommand>`; `--help` lists them.

`npm run setup` (the `install` subcommand) writes the launcher to
`~/.local/share/foxhand/foxhand-host` and the native manifest to
`~/.mozilla/native-messaging-hosts/foxhand.json`; both paths derive from `$HOME` only. The
launcher runs this checkout's `main.ts` with the absolute path of the Node that ran setup,
so rerun setup after moving or switching checkouts or Node versions.
`npm run setup -- --no-claude` and `npm run teardown -- --no-claude` leave Claude Code's
user configuration unchanged, for a checkout that should not touch it.

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

## Dependency updates

Dependabot opens pull requests every Thursday: npm updates grouped into one for development
and one for production dependencies, and one per GitHub Action. It proposes a new release only
once it is 3 days old; security updates skip that wait. The `Auto-merge Dependabot` workflow
squash-merges such a pull request once CI and all of its checks pass; one that fails stays open
for a person to fix. After merging, the workflow starts CI on `main` itself, because a merge made
with its own token starts no push run. The CI run it starts tests the updates merged together.
