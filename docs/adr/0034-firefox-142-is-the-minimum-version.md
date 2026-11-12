# 0034: Firefox 142 is the minimum version

**Status:** Accepted, 2026-10-30.

## Context

[0006](0006-no-firefox-for-android-key-in-the-manifest.md) kept `gecko.strict_min_version`
at `140.0` so Firefox ESR 140 could run Foxleash. Without a `gecko_android` key,
addons-linter checks Firefox for Android against `strict_min_version`, and Firefox for
Android supports `browser_specific_settings.gecko.data_collection_permissions` only from
142, so the linter warns `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`. 0006 allowed
exactly that warning in the extension build, and AMO showed it on every upload. It said to
revisit when the oldest supported Firefox is 142 or later.

That now holds. Mozilla's product details
(https://product-details.mozilla.org/1.0/firefox_versions.json, read 2026-10-28) list
`FIREFOX_ESR` as 153.6.0esr and no ESR 140. The last 140 update was 140.17.0esr on
2026-09-29; 153.5.0esr (2026-10-13) and 153.6.0esr (2026-10-27) shipped with no 140
release. ESR 115 is still listed, but it was already below Foxleash's minimum.

We built the extension, set `strict_min_version` in copies of `dist/` and ran
`web-ext lint --output json --no-config-discovery` on each, with web-ext 10.8.0
(addons-linter 10.14.0):

| `strict_min_version` | Errors | Warnings | Notices |
|---|---|---|---|
| `140.0` | 0 | 1, `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` | 0 |
| `141.0` | 0 | 1, the same code | 0 |
| `142.0` | 0 | 0 | 0 |

So 142 is the lowest version that removes the warning. Bundling with the esbuild target
`firefox142` instead of `firefox140` gave byte-identical `background.js`, `options.js`,
`approve.js` and `content.js`.

## Decision

`apps/extension/manifest.json` sets `gecko.strict_min_version` to `142.0`, and
`apps/extension/build.ts` bundles for the esbuild target `firefox142`. The manifest still
has no `gecko_android` key: 0006's decision on that stands.

`apps/extension/lint.ts` fails the build on every error and every warning in the web-ext
lint report; notices pass. It still ignores web-ext's `WEB_EXT` environment variables and
config files, and fails when it cannot read the report.

Unit tests in `apps/extension/lint.test.ts` refuse a manifest with `gecko_android`, a
`strict_min_version` other than `142.0`, and an esbuild target other than `firefox`
followed by the minimum's major version.

## Alternatives rejected

- **Staying on 140 with the allowance.** Every AMO upload shows a warning, and the build
  keeps a matcher tied to addons-linter's wording, for an ESR that Mozilla no longer
  updates.
- **Requiring 141.** Measured above: the linter still warns.
- **Adding `gecko_android`.** As in 0006: AMO would mark every version compatible with
  Firefox for Android, and its API cannot remove the mark.
- **Going back to `web-ext lint --warnings-as-errors` and dropping `lint.ts`'s JSON
  handling now that nothing is allowed.** `lint.ts` prints one line per finding with its
  code, file and position, fails on a report it cannot read, and ignores web-ext's
  `WEB_EXT` variables and config files, with unit tests behind each.

## Consequences

Firefox 140 and 141, ESR 140 included, cannot install Foxleash versions from this one on.

AMO's validation of an upload is expected to show no warning about Firefox for Android:
the local addons-linter 10.14.0 reports none, but AMO runs its own linter version.

Any warning a later addons-linter adds fails the build until it is dealt with.

Revisit if addons-linter starts checking Firefox for Android against something other than
`strict_min_version`; then decide again whether the absent `gecko_android` key needs
anything.
