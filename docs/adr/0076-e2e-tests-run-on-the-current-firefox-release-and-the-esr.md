# 0076: End-to-end tests run on the current Firefox release and the ESR

**Status:** Accepted, 2026-11-17.

## Context

Until now every end-to-end run was on one pinned Firefox, 156.0.1 (ADR 0003), while users run
Mozilla's current release or the ESR. On 2026-11-17 the release was 160.0.1 and the ESR
153.7.0esr, and the unmodified suite was measured on several versions:

- On Firefox 159.0 and 160.0 it failed before any tool call. BiDi answered `Navigation to
  "moz-extension://.../options.html" is not allowed in this context`, and Marionette answered
  `System access is required. Start Firefox with the "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1"
  environment variable set to enable it.` The `--remote-allow-system-access` flag (ADR 0008) is
  no longer enough there. With `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` in Firefox's environment, the
  same suite passed on 160.0: 439 tests, 438 pass, 0 fail, 1 todo. 157.0 and 158.0 need no
  variable.
- On 153.7.0esr, 428 tests passed and 10 failed, all with `Failed to load
  moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs`. The harness's privileged
  session-store scripts import `TabStateFlusher.sys.mjs` and `SessionStore.sys.mjs` from
  `moz-src:///browser/components/sessionstore/`. Mozilla's `browser/components/sessionstore/moz.build`
  installs them as `EXTRA_JS_MODULES.sessionstore` on the `esr153` branch, that is under
  `resource:///modules/sessionstore/`, and as `MOZ_SRC_FILES` on the `release` branch.

So a pin raise alone breaks the suite, and a passing suite on one pin says nothing about the
other Firefox users run.

## Decision

The suite runs on two pins. The current release is pinned in `bin/firefox-version.json`, the
ESR in `bin/firefox-esr-version.json`, each with the sha256 of its linux-x86_64 tarball from
Mozilla's `SHA256SUMS`. `bin/install-firefox.ts` installs the pin `FOXLEASH_E2E_FIREFOX`
selects: `esr` for the ESR, unset, empty or `release` for the release; any other value stops the
run with an error naming the variable, so a typo never runs the tests on the wrong Firefox.

CI runs both pins as three shards each, six jobs. The shard total in `FOXLEASH_E2E_SHARD` is
the literal 3, not `strategy.job-total`, which counts the jobs of both pins. Each pin has its
own cache key, from `matrix.firefox` and the hash of that pin's file.

The harness works on both versions. `IMPORT_SESSION_STORE` in `e2e/firefox.ts` defines
`importSessionStore()` in the session-store scripts: it imports from `moz-src:///` and falls
back to `resource:///modules/sessionstore/`. Firefox starts with both the
`--remote-allow-system-access` flag, which 153 to 158 read, and
`MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` in its environment, which 159 and later require.

## Alternatives rejected

- An unpinned latest Firefox. Results would change by themselves, which ADR 0003 rejected.
- The release only. The ESR's Firefox would stay unmeasured, and the session-store failure
  above shows it differs.
- Picking the module path from the Firefox version. It needs a version parse inside the
  script; the fallback is shorter and also survives a later move of the modules.

## Consequences

CI's end-to-end job minutes double; the six jobs run in parallel, so the wall time stays about
one shard's. Harness code must work on both versions, and a change that uses a newer Firefox
API needs a fallback or a check on the ESR. Each pin is raised by hand, as its own change, and
the ESR pin moves to the next ESR major when Mozilla's current ESR does. Measurements in older
ADRs remain those of the Firefox version they name.
