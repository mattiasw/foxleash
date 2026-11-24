# 0072: The extension serves the server of the release before, and a server refuses only an older extension

**Status:** Accepted, 2026-11-17. Supersedes the exact protocol check of
[0001](0001-two-processes-joined-by-a-unix-socket.md) and the consequence of
[0043](0043-read-page-finds-lines-by-the-text-it-shows.md),
[0065](0065-read-network-leaves-out-headers-unless-asked.md) and
[0067](0067-read-network-shows-request-body-shapes-without-values.md) that an extension and a
server of different protocol versions refuse each other.

Amended 2026-11-24: `OLDEST_SERVED_PROTOCOL` is capped by the newest release npm has served for
14 days, not the latest, since npx under an npm release-age limit installs the newest release
older than the limit ([measurements](../measurements/npm-release-age-limits.md)); current numbers
and steps are dropped.

## Context

Firefox updates the add-on by itself, at a moment it chooses. The installed program (the
`foxleash` MCP server and native host) changes only when its user runs a command. Before this record
the parts refused each other unless their `PROTOCOL_VERSION` was equal, so every raise stopped
every installation once Firefox fetched the new add-on.

Most protocol changes add a param that is off by default or a key to a result, which an older
server drops. Some do not: [0065](0065-read-network-leaves-out-headers-unless-asked.md) made
`read_network` leave out the header lists unless asked, while the server of 0.4.1 (protocol 3)
never asks and needs both lists.

## Decision

The extension serves a window of protocol versions, from `OLDEST_SERVED_PROTOCOL` up to
`PROTOCOL_VERSION` (both in `packages/protocol/src/index.ts`), and says so in its hello with the
field `oldestProtocol`. The host passes it on in the extension status of its welcome, so `doctor`
sees it too.

`protocolMismatch` (`packages/protocol/src/handshake.ts`) returns null when the part on the lower
protocol is at or above the other part's oldest protocol (its `protocol` when it has none). So a
host or `doctor` accepts a newer extension whose window reaches down to it, and refuses an
extension older than itself whatever its window says. The MCP server and the native host give no
window and stay exact with each other: they are one installed program, so a difference means a
process from before an update still runs.

A connection speaks the host's protocol in everything on its port. The extension records the
verdict of the host's welcome per port (`apps/extension/src/connection.ts`) and answers every
request on a port without a welcome, or with a refused one, with `protocol_mismatch`. A served
request goes through `answerAs` (`apps/extension/src/served-protocols.ts`), which applies one step
per protocol version from the host's up to the current one: each step can rewrite a request of
its version into one of the next, and the result back, around the handler of the current
protocol, after the same checks.

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
- `OLDEST_SERVED_PROTOCOL` is never above the `PROTOCOL_VERSION` of the newest release npm has
  served for 14 days; raised to that number, the steps below it are deleted. Under an npm
  release-age limit `npx foxleash@latest setup` installs the newest release older than the limit,
  so a limit of up to 14 days never leaves a program the add-on refuses.
  `npm run check:release -- protocol` enforces it.
- A fix to a safeguard that runs in the server, such as the untrusted-content marking or the
  upload folder policy, is made binding by raising the number in the fix release and letting the
  step for the version left behind refuse the requests the fix protects.
- A release makes its server available only once its add-on version can be installed (for a
  listed version, once AMO serves it publicly), because a server refuses an add-on older than
  itself.

## Alternatives rejected

- **Additive changes with negotiated capabilities.** The change of
  [0065](0065-read-network-leaves-out-headers-unless-asked.md) flips a default and is not
  additive. Flags per feature multiply the combinations to test.
- **The server also serving older extensions.** The extension updates by itself, so it runs
  ahead; serving both directions doubles the old shapes kept.
- **Keeping the exact check and only telling the user.** Every raise would still stop every
  installation.
- **Serving hosts from before this record by opening the port again with their number.** It
  costs two host starts per connection and a guess at the first hello.
- **Publishing to npm before AMO, so a release ages sooner.** A server refuses an add-on older
  than itself, so its program waits for its add-on (the last rule above).
- **Showing the npm override in the add-on's "program too old" text** (settings page, first-run
  page, tool errors). It would teach every user to bypass their limit, which the 14-day rule makes
  needless up to 14 days; the README covers longer limits.
- **`doctor` detecting a release-age limit.** `npx foxleash doctor` runs under the same limit,
  and with the 14-day rule such a limit does not cause the refusal it would explain.

## Consequences

- Old shapes cost code in the extension until the window passes them.
- Programs from before this record, protocol 3 to 5 (0.4.1 and older, and builds of `main`
  before this change), check exactly and refuse a newer extension.
- An add-on older than the server is still refused. That stays possible on release days, because
  Firefox looks for add-on updates on an interval.
