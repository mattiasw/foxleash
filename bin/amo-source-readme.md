# Foxleash source

Foxleash is a Firefox extension that lets an AI agent on the user's computer use their
Firefox through MCP tools. The extension talks to a native host, a separate program that
is not part of this archive.

## Requirements

- Linux or macOS
- Node.js {{node}}
- npm {{npm}}

Use exactly these versions: they are the ones this archive was built and checked with.

## Build

From the root of this archive, run:

```sh
npm ci && npm run build
```

The archive's `.npmrc` turns off the install scripts of the dependencies; the build needs none
of them.

The unminified extension appears in `apps/extension/dist/`: `background.js`, `options.js`,
`welcome.js` and `content.js`, bundled by esbuild from `apps/extension/src/` and
`packages/protocol/src/`; `approve.js`, `propose.js` and `run.js`, bundled from
`apps/extension/src/`; `options.html`, the settings page, `welcome.html`, the page that opens
once when the extension is installed, `approve.html`, the page that asks the user to approve a
site, `propose.html`, the page where the user saves or discards a recipe the agent proposes, and
`run.html`, the page where the user allows a recipe's sites for a session, all styled by
`pages.css`; plus `manifest.json` and the icon.
