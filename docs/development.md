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

## Dependency updates

Dependabot opens pull requests every Thursday: npm updates grouped into one for development
and one for production dependencies, and one per GitHub Action. It proposes a new release only
once it is 3 days old; security updates skip that wait. The `Auto-merge Dependabot` workflow
squash-merges such a pull request once CI and all of its checks pass; one that fails stays open
for a person to fix.
