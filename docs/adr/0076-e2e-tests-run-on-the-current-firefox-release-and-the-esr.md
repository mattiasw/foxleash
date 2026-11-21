# 0076: End-to-end tests run on the current Firefox release and the ESR

**Status:** Accepted, 2026-11-17.

Amended 2026-11-21: CI deals the test files to its shards by measured duration; dealt by name,
one shard neared its step limit.

## Context

Until now every end-to-end run was on one pinned Firefox, 156.0.1 (ADR 0003), while users run
Mozilla's current release or the ESR. On 2026-11-17 (release 160.0.1, ESR 153.7.0esr) the
unmodified suite was measured on several versions:

- On Firefox 159.0 and 160.0 it failed before any tool call. BiDi answered `Navigation to
  "moz-extension://.../options.html" is not allowed in this context`, and Marionette answered
  `System access is required. Start Firefox with the "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1"
  environment variable set to enable it.` The `--remote-allow-system-access` flag (ADR 0008) is
  no longer enough there. With the variable set, the suite passed on 160.0: 439 tests, 438
  pass, 1 todo. 157.0 and 158.0 need no variable.
- On 153.7.0esr, 10 of 438 tests failed with `Failed to load
  moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs`. The harness's privileged
  scripts import the session-store modules from `moz-src:///`, but Mozilla's
  `esr153` branch installs them under `resource:///modules/sessionstore/`.

So a pin raise alone breaks the suite, and one pin's passing suite says nothing about the
other.

## Decision

The suite runs on two pins: the current release in `bin/firefox-version.json`, the ESR in
`bin/firefox-esr-version.json`, each with the sha256 of its linux-x86_64 tarball from Mozilla's
`SHA256SUMS`. `bin/install-firefox.ts` installs the pin `FOXLEASH_E2E_FIREFOX` selects: `esr`
for the ESR, unset, empty or `release` for the release; any other value is an error naming
the variable.

CI runs both pins as three shards each, six jobs. The shard total in `FOXLEASH_E2E_SHARD` is
the literal 3, not `strategy.job-total`, which counts the jobs of both pins. Each pin has its
own cache key, from `matrix.firefox` and the hash of that pin's file. `bin/e2e-shard.ts` deals
the test files to the shards by measured duration from `bin/e2e-durations.json`, not by Node's
`--test-shard` ([measurements](../measurements/e2e-shard-durations.md)).

The harness works on both versions. `IMPORT_SESSION_STORE` in `e2e/firefox.ts` defines
`importSessionStore()`, which imports from `moz-src:///` and falls back to
`resource:///modules/sessionstore/`. Firefox starts with both the `--remote-allow-system-access`
flag, which 153 to 158 read, and `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`, which 159 and later
require.

## Alternatives rejected

- An unpinned latest Firefox: results would change by themselves (ADR 0003).
- The release only: the session-store failure shows that the ESR differs.
- Picking the module path from the Firefox version: it needs a version parse; the fallback is
  shorter and survives a later move.
- Node's `--test-shard`: it deals by sorted name, and left shard 3 at 744 s of the 900 s step
  limit.
- A fourth shard dealt the same way: it moves the clustering rather than removing it, and adds
  two jobs.

## Consequences

CI's end-to-end job minutes double; the six jobs run in parallel, so the wall time stays about
one shard's. Harness code must work on both: a newer Firefox API needs a fallback or an ESR
check. Each pin is raised by hand, as its own change, and the ESR pin moves to the next ESR
major when Mozilla's does. Measurements in older ADRs remain those of the Firefox version they
name.
