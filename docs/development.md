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

## Checks

| Check | Command |
|---|---|
| Lint and format | `npm run lint` |
| Type check | `npm run typecheck` |
| Unit tests | `npm test` |
| Build | `npm run build` |

The server's TypeScript runs directly on Node (type stripping), so it has no build step.
Running Node with `--preserve-symlinks` breaks this for the workspace packages: Node
refuses to strip types from files it sees under `node_modules`.

## Extension

`npm run build` bundles the extension into `apps/extension/dist/`: the manifest with the
version from `apps/extension/package.json`, an unminified `background.js`, and the icon. It
then runs `web-ext lint --warnings-as-errors` on that folder.

`npm run dev` rebuilds `background.js` whenever its TypeScript source changes and runs Firefox
through `web-ext run`, which reloads the extension after each rebuild. It writes the manifest
and the icon once at start, so restart it after changing them. Firefox uses a persistent
profile in `$XDG_CACHE_HOME/foxhand/dev-profile` (by default
`~/.cache/foxhand/dev-profile`), so what you set up there, such as logins, stays between
runs. It needs a desktop with Firefox 140 or later.

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

## Dependency updates

Dependabot opens pull requests every Thursday: npm updates grouped into one for development
and one for production dependencies, and one per GitHub Action. It proposes a new release only
once it is 3 days old; security updates skip that wait. The `Auto-merge Dependabot` workflow
squash-merges such a pull request once CI and all of its checks pass; one that fails stays open
for a person to fix. After merging, the workflow starts CI on `main` itself, because a merge made
with its own token starts no push run. The CI run it starts tests the updates merged together.
