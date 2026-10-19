# Foxhand source

Foxhand is a Firefox extension that lets an AI agent on the user's computer use their
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

The unminified extension appears in `apps/extension/dist/`: `background.js`, bundled by
esbuild from `apps/extension/src/` and `packages/protocol/src/`; `options.js`, bundled from
`apps/extension/src/`; `options.html` and `pages.css`, the settings page; plus
`manifest.json` and the icon.
