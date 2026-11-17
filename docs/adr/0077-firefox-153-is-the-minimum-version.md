# 0077: Firefox 153 is the minimum version

**Status:** Accepted, 2026-11-17. Supersedes the minimum version of [0034](0034-firefox-142-is-the-minimum-version.md).

## Context

[0034](0034-firefox-142-is-the-minimum-version.md) chose 142 only from the linter: it is the
lowest version at which addons-linter, without a `gecko_android` key, reports no Firefox for
Android warning. Foxleash itself was not measured on 142.

Measured on 2026-11-17:

- `screenshot` captures with `tabs.captureTab`. On Firefox 142.0, 149.0 and 151.0 the call
  throws `TypeError: browser2.tabs.captureTab is not a function`; on 153.0, 153.6.0esr and
  156.0.1 it works; 152.0 was not measured. The handler fails closed: no image, and the
  result says Firefox could not take a screenshot of the tab. MDN's compatibility data
  (`@mdn/browser-compat-data` 8.1.4, which addons-linter 10.14.0 uses) lists
  `tabs.captureTab` from Firefox 59, so the linter has nothing to report at 142, and why the
  call is missing on those versions is not established.
- The unmodified end-to-end suite on Firefox 142.0: 388 of 439 tests pass and 50 fail. 15
  failures say "Firefox could not take a screenshot of tab N". "tab_open of a page url with a
  fragment returns the page" fails after 31 s. "type into an editor's input frame on the
  page's site is sent but unconfirmed" fails with "type needs a text field or an editable
  area". Three reading fixtures differ (hidden-details-visibility, text-shadow-answer,
  rendered-wrapped-option). About 24 of the 50 are the test harness's own privileged helpers,
  which do not exist on 142 (`Services.logins.removeAllUserFacingLoginsAsync`,
  `CreditCardRecord.computeFields`, the `TabStateFlusher` module path). So on 142 the suite
  cannot run, and the safeguards it checks are unmeasured there.
- On Firefox 153.7.0esr the same suite: 428 pass and 10 fail, all 10 in one harness helper,
  the session-store import that
  [0076](0076-e2e-tests-run-on-the-current-firefox-release-and-the-esr.md) has since given a
  fallback. On Firefox 160.0: 438 pass, 0 fail.

Mozilla's product details (https://product-details.mozilla.org/1.0/firefox_versions.json,
read 2026-11-17) list `FIREFOX_ESR` as 153.7.0esr and `LATEST_FIREFOX_VERSION` as 160.0.1.
ESR 115 is still listed (`FIREFOX_ESR115` 115.45.0esr), as 0034 recorded; it is below every
minimum Foxleash has had. Firefox 142 to 152 are no longer updated.

We built the extension with `strict_min_version` `142.0` and esbuild target `firefox142`, and
with `153.0` and `firefox153`, and ran `web-ext lint --output json --no-config-discovery` on
each, with web-ext 10.8.0 (addons-linter 10.14.0):

| `strict_min_version` | Errors | Warnings | Notices |
|---|---|---|---|
| `142.0` | 0 | 0 | 0 |
| `153.0` | 0 | 0 | 0 |

With esbuild 0.28.2, the target `firefox153` instead of `firefox142` gave byte-identical
`approve.js`, `propose.js`, `run.js`, `content.js` and `welcome.js`. `background.js` and
`options.js` differ in four lines each and nowhere else: four regular expressions from
`apps/extension/src/recipes.ts` with a `\p{...}` property escape outside a character class.
For targets up to `firefox146` esbuild writes such a regular expression as a
`new RegExp(...)` call with the same pattern and flags; for `firefox153` it leaves it as a
literal.

## Decision

`apps/extension/manifest.json` sets `gecko.strict_min_version` to `153.0`, and
`apps/extension/build.ts` bundles for the esbuild target `firefox153`.

0034's rule that `apps/extension/lint.ts` fails the build on every web-ext lint error and
warning stands, and so does [0006](0006-no-firefox-for-android-key-in-the-manifest.md)'s
absent `gecko_android` key: 153 is above 142, so the linter's Firefox for Android check still
passes.

Unit tests in `apps/extension/lint.test.ts` refuse a `strict_min_version` other than `153.0`
and an esbuild target other than `firefox` followed by the minimum's major version.

Since 0076 the end-to-end suite runs in CI on 153.7.0esr, the ESR of the minimum's major
version, and on the current release. A unit test in `bin/install-firefox.test.ts` refuses an
ESR pin (`bin/firefox-esr-version.json`) of another major version than the minimum's.

## Alternatives rejected

- **Keeping 142 and stating the limits in the listing.** The suite cannot run there, so the
  safeguards stay unmeasured on those versions, and screenshots never work.
- **Requiring 152.** Not measured, not an ESR, and Mozilla no longer updates it.
- **Detecting whether `captureTab` exists and leaving screenshots out where it does not.**
  Firefox 142 to 152 would still be unmeasured.

## Consequences

Firefox 142 to 152 cannot install Foxleash versions from this one on; a user there keeps the
signed 0.5.0 until Firefox is updated.

The suite runs on the ESR pin (153.7.0esr), not on 153.0 itself; `captureTab` was measured to
work on 153.0.

The reason [0036](0036-the-propose-page-shows-the-whole-steps.md) and
[0037](0037-the-propose-page-shows-the-whole-name-and-description.md) gave for not using CSS
`field-sizing` (Firefox has it from 152, Foxleash supported 142) no longer holds; their
decisions are not changed here.

Revisit when Mozilla's ESR moves to its next major version, when 0076 moves the ESR pin:
that unit test then fails until the same change raises the minimum to the new ESR's major
version or a new record decides otherwise.
