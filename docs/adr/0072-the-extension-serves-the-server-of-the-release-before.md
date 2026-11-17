# 0072: The extension serves the server of the release before, and a server refuses only an older extension

**Status:** Accepted, 2026-11-17. Supersedes the exact protocol check of
[0001](0001-two-processes-joined-by-a-unix-socket.md) and the consequence of
[0043](0043-read-page-finds-lines-by-the-text-it-shows.md),
[0065](0065-read-network-leaves-out-headers-unless-asked.md) and
[0067](0067-read-network-shows-request-body-shapes-without-values.md) that an extension and a
server of different protocol versions refuse each other.

## Context

Firefox updates the add-on by itself, at a moment it chooses. The installed program (the
`foxleash` MCP server and native host) changes only when its user runs a command. Until now the
parts refused each other unless their `PROTOCOL_VERSION` was equal, so every release that raised
the number stopped every installation as soon as Firefox fetched the new add-on, until the user
noticed and updated the program.

Most protocol changes add a param that is off by default or a key to a result, which an older
server drops. Some do not: [0065](0065-read-network-leaves-out-headers-unless-asked.md) made
`read_network` leave out the header lists unless asked, while the server of 0.4.1 (protocol 3)
never asks and needs both lists on every request.

## Decision

The extension serves a window of protocol versions, from `OLDEST_SERVED_PROTOCOL` up to
`PROTOCOL_VERSION` (both in `packages/protocol/src/index.ts`; 3 and 6 today), and says so in its
hello with the field `oldestProtocol`. The host passes it on in the extension status of its
welcome, so `doctor` sees it too.

`protocolMismatch` (`packages/protocol/src/handshake.ts`) returns null when the part on the lower
protocol is at or above the other part's oldest protocol (its `protocol` when it has none). So a
host or `doctor` accepts a newer extension whose window reaches down to it, and refuses an
extension older than itself whatever its window says. The MCP server and the native host give no
window and stay exact with each other: they are one installed program, and a difference means a
process from before an update is still running, which the existing sentences name.

A connection speaks the host's protocol in everything on its port. The extension records the
verdict of the host's welcome per port (`apps/extension/src/connection.ts`) and answers every
request on a port without a welcome, or with a refused one, with `protocol_mismatch`. A served
request goes through `answerAs` (`apps/extension/src/served-protocols.ts`), which applies one step
per protocol version from the host's up to the current one: each step can rewrite a request of
its version into one of the next and a result of the next back into one of its version, around
the same handler that answers the current protocol, after the same checks.

The steps today are:

- From 3: a `read_network` request keeps only its own `tabId`, `pattern` and `limit`, the params
  protocol 3 had, and gets `headers: true`, so the result carries both header lists as protocol 3
  needs.
- From 4 and from 5: nothing differs. Protocol 5 added `body` and protocol 6 `responseBody` to
  `read_network`, each off unless true and adding its result key only then, so a request of 4 or 5
  gets a result of its own version.

The rules for later changes:

- The commit that raises `PROTOCOL_VERSION` adds the step for the version it leaves behind: the
  rewrite of the old shape with a test through the real handler, or a comment saying why nothing
  differs. A unit test demands one step per version in the window.
- A step changes shape only. It never relaxes a safeguard, and it refuses the request with a
  `ToolError` when it cannot serve the old shape without doing so. When no rewrite can serve an
  older shape, the old handler is kept and the step routes to it. A message that is neither a
  request nor its result, such as `session_end`, is handled by the port's protocol where it is
  read or sent.
- A method name, and the fields of the hello and the welcome, stay while a served version uses
  them.
- `OLDEST_SERVED_PROTOCOL` is never above the `PROTOCOL_VERSION` of the latest release. It may be
  raised to that number, and the steps below it are then deleted.
- A fix to a safeguard that runs in the server, such as the untrusted-content marking (`untrusted`
  in `apps/server/src/tools.ts`) or the upload folder policy (`apps/server/src/upload-policy.ts`),
  is made binding by raising the number in the fix release and letting the step for the version
  left behind refuse the requests the fix protects.
- A release makes its server available only once its add-on version can be installed (for a
  listed version, once AMO serves it publicly), because a server refuses an add-on older than
  itself.

## Alternatives rejected

- **Additive changes with negotiated capabilities.** The change of
  [0065](0065-read-network-leaves-out-headers-unless-asked.md) flips a default and is not
  additive. A flag per feature on each side makes the combinations to test grow with every
  feature.
- **The server also serving older extensions.** The extension is the part that updates by itself,
  so it is the part that runs ahead. Serving both directions doubles the old shapes kept.
- **Keeping the exact check and only telling the user.** Every raise would still stop every
  installation.
- **Serving hosts from before this record by opening the port again with their number.** It
  costs two host starts per connection and a guess at the first hello.

## Consequences

- Old shapes cost code in the extension until the window passes them.
- Programs from before this record, protocol 3 to 5 (0.4.1 and older releases, and builds of
  `main` before this change), check exactly: they refuse a newer extension by their own check. So
  today the steps for 3 to 5 serve no existing program. The window takes effect from the first
  release that carries this record, and once that release ships, `OLDEST_SERVED_PROTOCOL` may be
  raised to its number and those steps deleted.
- An add-on older than the server is still refused. That stays possible on release days, because
  Firefox looks for add-on updates on an interval.
