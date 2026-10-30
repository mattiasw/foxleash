# 0006: The manifest has no Firefox for Android key

**Status:** Accepted, 2026-10-18. Its minimum version of 140 and its lint allowance are superseded by [0034](0034-firefox-142-is-the-minimum-version.md), 2026-10-30.

## Context

Foxhand cannot work on Firefox for Android: it has no `nativeMessaging` or `tabGroups` API,
and there is no local Foxhand program for the extension to talk to.

AMO takes Firefox for Android compatibility from the manifest's
`browser_specific_settings.gecko_android` key. A version whose manifest has the key is
marked compatible with Firefox for Android from its `strict_min_version`, even when the
submission requests Firefox only, and AMO's API refuses to remove that mark afterwards.
This is in AMO's server code (addons-server, `Version.from_upload` and the version
`compatibility` field of its API), not in the public API documentation.

Without the key, addons-linter falls back to `gecko.strict_min_version` (140) for its
Firefox for Android checks. Firefox for Android supports
`browser_specific_settings.gecko.data_collection_permissions` only from 142, so the linter
warns `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`, and `web-ext lint
--warnings-as-errors` fails. No web-ext lint option removes this one warning:
`--ignore-files` works on files, and `--self-hosted` and `--enterprise` were tried and still
report it. This behaviour was observed with web-ext 10.7.0 (addons-linter 10.13).

## Decision

`apps/extension/manifest.json` has no `gecko_android` key, and `gecko.strict_min_version`
stays `140.0`.

`apps/extension/lint.ts`, run by the extension build after the bundle, runs `web-ext lint`
with JSON output and fails on every error and every warning except that one, matched by its
code, its file (`manifest.json`) and its whole description, which names the
`data_collection_permissions` key. It ignores web-ext's `WEB_EXT` environment variables and
config files, and fails when it cannot read the report. A unit test refuses a manifest with
`gecko_android`.

## Alternatives rejected

- **Adding `gecko_android` back to quiet the linter.** AMO would mark every version
  compatible with Firefox for Android, and its API cannot remove the mark.
- **Raising `gecko.strict_min_version` to 142.** It drops Firefox ESR 140 and changes the
  stated requirement.
- **Keeping `--warnings-as-errors` and quieting the warning with a web-ext option.** None
  exists: `--self-hosted` and `--enterprise` still report it.
- **Importing addons-linter as a library.** It is only a transitive dependency of web-ext.

## Consequences

One known linter warning is allowed, matched by code, file and key. AMO's own validation of
each upload shows that warning, which the reviewer notes in `docs/amo/listing.md` explain.
If a later addons-linter rewords the message, the build fails until the match is updated.

Revisit when addons-linter stops the fallback, or when the oldest supported Firefox is 142
or later: then raise `strict_min_version`, and the allowance goes.
