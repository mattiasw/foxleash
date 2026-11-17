# 0001: Foxleash runs as two processes joined by a Unix socket, with a protocol version handshake

**Status:** Accepted, 2026-10-17. Its exact protocol check is superseded by [0072](0072-the-extension-serves-the-server-of-the-release-before.md), 2026-11-17.

## Context

Foxleash connects an MCP client to a Firefox extension:

```
MCP client --stdio--> foxleash mcp --Unix socket--> foxleash host --native messaging--> Firefox extension
```

Each end starts its own process. The MCP client starts `foxleash mcp` and uses its stdio as
the MCP transport. Firefox starts `foxleash host` through `runtime.connectNative` and uses
its stdio as the native messaging channel. Neither parent can be handed a process the
other one started, so there must be two processes. They are one Node program with two
entry points.

Both stdouts belong to their parent. Anything else written there breaks the channel, so
all logging goes to stderr.

The two parts also ship separately. The extension updates through AMO signing, the server
through `git pull`. A user can therefore run an extension and a server at different
versions.

## Decision

The host listens on a Unix socket in `$XDG_RUNTIME_DIR/foxleash/`. It creates that
directory with mode 0700, and refuses to use it if it belongs to another user or if other
users can open it. This limits connections to the same user.

Each Firefox instance starts its own host, with its own socket. The MCP server uses the
most recently started host that answers. `foxleash doctor` lists all of them. When no host
is running, every tool fails with one sentence that tells the user to start Firefox and
run `foxleash doctor`.

The extension opens the native port as soon as its background script runs and keeps it
open, which also keeps its event page alive. When the port drops, the extension
reconnects.

On connect, the extension, the host and the MCP server exchange their protocol version,
`PROTOCOL_VERSION` exported from `packages/protocol/src/index.ts`. A mismatch fails with a
message that names the part to update. The message shapes of the handshake belong to the
protocol package, not to this record.

Several MCP sessions can connect to one host at once. Each session gets its own Firefox
tab group and acts only on the tabs in it.

## Alternatives rejected

- **One process.** Not possible: the MCP client and Firefox each spawn their own child and
  talk to it over its stdio.
- **A localhost TCP or WebSocket port.** Any local user can connect to it, and a web page
  in the browser can reach localhost too. Closing that would need a token. A Unix socket
  in a 0700 directory needs none, because the file system already limits who can connect.
- **A relay through a remote service.** Data from the user's browser would leave the
  machine.
- **No version check.** When the extension and the server drift apart, requests would
  break in ways that are hard to trace. A check on connect turns that into one clear
  message.

## Consequences

The socket path follows Linux conventions, so only Linux is supported for now.

Firefox's native messaging limits cap a message from the host to the extension at 1 MB.
Large payloads in that direction, such as file uploads, are sent in chunks. Messages the
other way are capped at 4 GB, so screenshots go through whole.

Each Firefox instance has its own host, so a user with several instances open has several
sockets.
