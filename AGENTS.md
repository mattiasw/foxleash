# Foxhand - Agent Guide

Foxhand lets an AI agent on your computer, such as Claude Code, use your own Firefox
through MCP tools. It has three parts:

```
MCP client --stdio--> foxhand mcp --Unix socket--> foxhand host --native messaging--> Firefox extension
```

`foxhand mcp` is started by the MCP client, `foxhand host` by Firefox. The host relays
requests from MCP servers to the extension and routes the responses back. Firefox only.

## Project Structure

- `apps/extension/` - Firefox MV3 extension (TypeScript, bundled with esbuild, unminified)
- `apps/server/` - the `foxhand` CLI: `mcp`, `host`, `install`, `uninstall`, `doctor`, `probe`;
  runs TypeScript directly on Node 24 (type stripping), no build step
- `packages/protocol/` - messages and method contracts shared by both, plus the protocol
  version
- `packages/tsconfig/` - shared TypeScript configuration
- `e2e/` - end-to-end tests in a real, headless Firefox
- `bin/` - build, release-check and test helper scripts
- `docs/` - `adr/` (architecture decisions), `amo/listing.md` (the add-on listing text),
  `development.md`

## Commands

| Task | Command |
|---|---|
| Lint and format check | `npm run lint` |
| Type check | `npm run typecheck` |
| Unit tests (with coverage floors) | `npm test` |
| Build the extension | `npm run build` |
| End-to-end tests | `npm run e2e` |
| Fast gate (run before every commit) | `npm run lint && npx turbo run typecheck test --force` |
| Install on this machine | `npm run setup` |
| Check the installation | `npm run doctor` |
| Develop the extension | `npm run dev` (temporary Firefox profile, rebuilds on change) |

Always run tests through the npm scripts, in CI too: the coverage floors live in the
scripts, and calling `node --test` directly runs the suite with them switched off.

## Conventions

- TypeScript everywhere, `strict`. Never `any`: use `unknown` and narrow.
- Erasable syntax only (no `enum`, `namespace` or parameter properties; `import type` for
  types), so Node can run the server source directly.
- Relative imports carry the `.ts` extension.
- Place functions in the order they are used: a function is defined after the place it is
  called from.
- kebab-case file names and package names.
- Biome formats and lints (`biome.json`). The pre-commit hook runs it on staged files.
- The MCP server writes nothing to stdout except MCP messages: stdout is its transport.
  Log to stderr. The native host's stdout belongs to Firefox in the same way.
- Comments only where the code cannot say it: a spec reference, a browser quirk, a subtle
  invariant. Keep them short.
- No em dashes in text users read (README, docs, CHANGELOG, the add-on listing, tool
  descriptions).

## Tests

- Unit tests use `node:test` and `node:assert/strict`, in `*.test.ts` files next to the
  source. No Jest, no Vitest, no module-mocking library. Code that talks to Firefox takes
  its `browser.*` dependency as a parameter, typed by the small interface in
  `apps/extension/src/browser-api.ts`, so tests pass a fake.
- Test real behaviour, not implementation details. Code that needs a real DOM or real
  Firefox behaviour (page reading, typing into editors) is tested end to end, not against
  a simulated DOM.
- End-to-end tests live in `e2e/`. They start a pinned Firefox headless with a temporary
  home directory, install the extension over WebDriver BiDi, and act as an MCP client
  calling the real tools against local fixture pages.
- Coverage floors are a ratchet: raise them when coverage rises, never lower them.
- Never delete a test file, and never commit `.only`, an unconditional `.skip`, or
  `x`/`f`-prefixed tests. `bin/check-test-integrity.sh` enforces both in CI. Fix the code,
  not the test.
- A new regression test is verified by breaking the behaviour it guards and watching it
  fail.

## Commits

- Sentence-case imperative subject, no conventional-commit prefix (`Add read_page tool`,
  not `feat: add read_page tool`). Usually subject-only; a body only for reasoning the
  diff cannot show.
- Describe the change, not the process that produced it.
- One logical change per commit, with its tests, docs and changelog entry.

## Changelog

When making notable changes (new features, bug fixes, breaking changes, etc.), add an
entry to the `Unreleased` section in `CHANGELOG.md`. Use the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format with the appropriate
change type: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or `Security`.

After updating, read through the whole `Unreleased` section again. Each change type must
appear at most once, in the Keep a Changelog order above, with all its entries under that
one heading.

Entries describe what a user notices, not how the code changed.

## Documentation

README.md and `docs/development.md` describe how to install, use and develop Foxhand.
Update them in the same commit as the behaviour they describe: a new tool, a changed
command, a new requirement or limit.

## The add-on listing must match what the extension does

Mozilla reviews add-ons against their listing, and drift between the listing, the
manifest and the extension's behaviour gets an add-on disabled as "deceptive or
misleading". So any change to:

- permissions or host permissions,
- `data_collection_permissions`,
- what data leaves the browser, or where it goes,
- what the extension can do on the user's behalf,

updates `apps/extension/manifest.json` and `docs/amo/listing.md` in the same commit. The
release check refuses a release where the manifest's permissions or data declarations
changed but the listing did not.

Firefox does not show users host permissions that an update adds, so adding one is a
listing change and a decision, not a routine edit.

## AMO source archive

Mozilla reviewers rebuild the extension from a source archive. `bin/build-amo` builds it
from an exact, committed file list (`bin/amo-source-files.txt`), rebuilds the extension
inside a clean copy and compares the result with the normal build. When you add, move or
delete a file that the extension build reads, update the list in the same commit; the
build fails on any file it cannot classify.

## Security

Foxhand acts in the user's logged-in browser, so a web page that injects instructions into
the model is the main threat. The safeguards live in Foxhand, not in the MCP client, whose
permission prompts can be switched off:

- A session acts on a site only after the user approved that site in the browser. Only a
  user click grants approval; nothing arriving over native messaging can.
- Financial and health sites are blocked by default.
- `upload_file` reads only from allowed folders and refuses dotfiles and key files.
- Tool results mark page content as untrusted.

Do not weaken any of these without an ADR. See `docs/adr/` for the threat model.

## Architecture decisions

Write an ADR in `docs/adr/` (copy `0000-template.md`) for each architecture decision: a
choice that constrains future code, or one that rejects an alternative the next
contributor would reasonably reach for. Write it in the same commit as the decision. When
a decision changes, write a new ADR that supersedes the old one; do not rewrite history.
Routine feature work and choices that are cheap to reverse need no ADR.

## Borrowed code

Prefer writing code over copying it from other projects. When copied code is the better
choice, record its origin, license and copyright in `THIRD_PARTY_NOTICES.md` in the same
commit.

## Dependencies

Add a package only for problems that are hard to get right (protocols, bundling). Small
utilities are written here.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
