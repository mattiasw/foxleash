# 0098: Setup installs a copy of the bundled program

**Status:** Accepted, 2026-11-19.

## Context

Foxleash is to be installed with `npx foxleash setup`, from an npm package named `foxleash`. The
server is TypeScript that Node runs by stripping its types, and Node refuses to do that under
`node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the source cannot ship as it
is. npx runs a package from a cache folder that npm may clear at any time, and Firefox starts the
native host without the PATH of the user's shell. The checkout route (`npm run setup`) and the
end-to-end harness, which install from the source, have to keep working.

## Decision

- The package is one bundled file. `apps/server/build.ts` (`npm run build`) bundles
  `src/main.ts` with esbuild into `apps/server/dist/foxleash.mjs` and writes a `package.json`
  with no dependencies, the repository's `LICENSE` and `README.md`, and a
  `THIRD_PARTY_NOTICES.md` generated from esbuild's metafile. The build refuses, before it writes
  anything, a bundled file it cannot attribute to a package under `node_modules` or to the
  workspace, a package whose `license` is not exactly one of MIT, ISC, BSD-2-Clause,
  BSD-3-Clause and Apache-2.0, and a package without a license file that is a non-empty regular
  file. The version comes from a JSON import of `apps/server/package.json`, which esbuild inlines.
- `programOf` in `cli.ts` tells the two runs apart by the file the code runs from: a `.ts` file
  is the source, and setup points Firefox and Claude Code at the checkout's `main.ts` as before;
  anything else is the bundle.
- From the bundle, setup (`install` in `install.ts`) copies the running file to
  `~/.local/share/foxleash/foxleash.mjs` after `homeRefusal` and before the launcher and the
  manifest. `copyProgram` reads the bytes first, creates a new randomly named file in that 0700
  folder with an exclusive create at mode 0600, writes it, sets 0600 again on the open file
  (the umask may have removed bits), closes it and renames it onto `foxleash.mjs`, removing the
  temporary file when a step fails. A host Firefox starts during setup runs the old file or the
  new one, never a partial one, and a symlink at either name is never followed. The launcher
  runs `exec '<node>' '<copy>' host` and Claude Code is registered with `<node> <copy> mcp`;
  uninstall removes the copy.

## Alternatives rejected

- Registering `npx foxleash mcp` with Claude Code and in the launcher: npx asks npm's registry
  at every session start, and the server's version would change without the user running
  anything, out of step with the host Firefox runs and with what doctor checks.
- Publishing the workspace `@foxleash/server` with its dependencies: the TypeScript source cannot
  run under `node_modules`, and the tests and the workspace dependencies would ship with it.

## Consequences

The installed program changes only when the user runs setup again (`npx foxleash@latest setup`).
setup names the add-on's page on Firefox Add-ons instead of downloading the add-on, so the page
answers only once the add-on is listed there; until then a signed `.xpi` goes in with `--xpi`.
The extension's pages and the sentence that says the add-on is behind name the same page.
A setup killed between the create and the rename leaves a `.foxleash.mjs.*.tmp` file, which is
never reused and keeps uninstall from removing the folder. A new bundled dependency under a
license outside the five stops the build until a decision allows it.
