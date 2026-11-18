# 0088: Foxleash does not run in private windows

**Status:** Accepted, 2026-11-18.

## Context

The manifest had no `incognito` key, so Firefox's default, `spanning`, applied: Firefox's
default for a new add-on is Don't Allow in private windows, but its install dialog offers Allow,
and once a user chose Allow the one extension instance saw private windows like normal ones.
Nothing in the code told them apart.

A manual check in Firefox Developer Edition 160.0b5 with Allow found three leaks across the
private window's boundary:

- With a private window in front, `tab_open` of a new site put the site question, and then the
  session's whole tab group, into the private window, and the agent read pages there.
- An Always allow answered in the private window was stored like any other answer: the site was
  still listed under the sites allowed always after the window closed. Firefox's own site
  permissions granted in a private window end with it.
- `download` from that session saved the file, and Firefox listed it in the normal windows'
  download list, before and after the private window closed, never in the private window's.
  The fetch uses the default cookie jar (ADR 0019), so it also requests the file with the normal
  windows' cookies; that follows from the code and was not measured.

With Don't Allow, the question went to a normal window and `tabs_list` did not show the private
window's tab.

## Decision

`apps/extension/manifest.json` declares `"incognito": "not_allowed"`. Firefox then never runs
Foxleash in private windows, whatever an earlier about:addons choice or an enterprise policy
says, and about:addons offers no switch for it: it shows "Not Allowed in Private Windows".

The test `never runs in private windows` in `apps/extension/lint.test.ts` checks the key's
top-level value, and the listing claim "It does not run in Firefox's private windows" in
`docs/amo/listing-claims.json` makes the listing release check fail when the manifest no longer
holds it.

## Alternatives rejected

- Supporting private windows properly: downloads saved with
  `downloads.download({ incognito: true })` and fetched with the private window's cookie store,
  an Always allow answered in a private window kept only while a private window is open, sessions
  that never mix private and normal tabs, and tests for all of it. Revisited if users ask for
  private windows.
- Leaving `spanning` and documenting the leaks: each one crosses a boundary the user chose a
  private window for.
- `split`: Firefox does not support it and falls back to `not_allowed` with a warning in the
  browser console, the same result stated less plainly.

## Consequences

The following were read from Firefox 160's code and Foxleash's, not measured in a running
Firefox, except where a measurement is named.

- An installed copy whose user chose Allow loses the permission when it starts as the updated
  version: `_setupStartupPermissions` in Firefox's
  `toolkit/components/extensions/Extension.sys.mjs` removes `internal:privateBrowsingAllowed`
  from an extension that declares `not_allowed`. Nothing is asked. Its branch that applies an
  enterprise policy's `private_browsing` setting is skipped for such an extension, so a policy
  cannot grant it back.
- A Foxleash tab group open in a private window at that update stays open as an ordinary Firefox
  tab group. The update restarts the background, which ends the session with its native port
  (ADR 0086), and Foxleash knows a group only in its background's memory, so it no longer sees,
  reads, acts in or closes those tabs. The user closes them.
- With a private window in front, the session's tab goes to a normal window, as the manual check
  measured with Don't Allow.
- With only private windows open, `tab_open` of a session without a group fails until a normal
  window is open: `tabs.create` without a window finds no normal window and throws. With the
  "Open each agent session in its own window" setting on, `windows.create` opens a normal window.
- With Firefox set to never remember history, or to always use private browsing mode, every
  window is private, including one the own-window setting opens, and Foxleash does not work at
  all. Foxleash can neither use nor close such a window (`tabs.create` and `windows.remove`
  refuse a window the extension may not access), so each attempt to open a tab leaves one more
  open. That was already so for users who kept Don't Allow.
- A site allowed always from a private window before the update stays allowed always, now in
  normal windows: no stored answer records the window it came from, so nothing can tell those
  sites apart. `docs/security.md` tells the user to revoke them.
- The Foxleash toolbar button does not show in private windows.
- ADR 0019's consequence that the default cookie jar leaves sessions in private windows or
  containers uncovered now concerns containers only.
