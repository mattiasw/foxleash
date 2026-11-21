# End-to-end shard durations

Measurements behind [ADR 0076](../adr/0076-e2e-tests-run-on-the-current-firefox-release-and-the-esr.md).

## Shards dealt by Node's `--test-shard` (2026-11-20)

CI runs the end-to-end suite on each Firefox pin as three shards, each `npm run e2e` step
stopped by `timeout` after 15 minutes (900 s). Node's `--test-shard` sorts the test files by
path and deals them out round-robin, whatever their duration. In CI run 44809266291 (commit
efe4208) the steps took:

| Shard | Tests | Release (s) | ESR (s) |
|---|---|---|---|
| 1/3 | 164 | 321 | 289 |
| 2/3 | 157 | 212 | 243 |
| 3/3 | 215 | 663 | 744 |

Shard 3/3 holds several of the longest files and grew with them, in the CI runs from
44531230026 to 44809266291:

| When | Tests in shard 3/3 | Release and ESR steps (s) |
|---|---|---|
| 2026-11-19 | 196 | 627 to 672 |
| early 2026-11-20 | 213 | 705 to 714 |
| late 2026-11-20 | 215 | 642 to 744 |

Past 900 s every CI run fails. The mean of the three ESR steps of run 44809266291 is
(289 + 243 + 744) / 3 = 425 s, so even a perfect deal over three shards sits near that.

## How the per-file durations are taken

`bin/e2e-durations-reporter.ts` measures them as the suite's `node --test` reporter:

```sh
FOXLEASH_TEST_REPORTER=./bin/e2e-durations-reporter.ts npm run e2e
```

The e2e script runs one test file at a time (`--test-concurrency=1`). The runner reports each
file's last event, a file-level `test:complete`, after the file's process has exited, so after
its `after` hooks and teardown. A file's duration is the time from the previous file's last
event (for the first file, from the reporter's start) to its own last event, rounded to a
tenth of a second, at least 0.1 s. The runner may announce a later file's tests early
(`test:enqueue`), which is why the measure is not taken from a file's first event. The
reporter writes `bin/e2e-durations.json` only when the run passed.

## Per-file durations (2026-11-21)

Measured with the command above in one run of the whole suite, 38 files, on the release pin,
Firefox 160.0.1, headless, a local Linux x86_64 run. `bin/e2e-durations.json` holds these
values; the shard column is where `bin/e2e-shard.ts` deals each file with them.

| File | Seconds | Shard |
|---|---|---|
| `e2e/approval.test.ts` | 195.4 | 1/3 |
| `e2e/recipes.test.ts` | 125.5 | 2/3 |
| `e2e/foreign-file.test.ts` | 116.7 | 3/3 |
| `e2e/read-page.test.ts` | 92.5 | 3/3 |
| `e2e/tabs.test.ts` | 75.6 | 2/3 |
| `e2e/read-after-navigation.test.ts` | 49.6 | 1/3 |
| `e2e/network-burst.test.ts` | 32.5 | 2/3 |
| `e2e/foreign-file-restart.test.ts` | 32.2 | 3/3 |
| `e2e/session-end.test.ts` | 31.2 | 2/3 |
| `e2e/fill-form.test.ts` | 26.1 | 3/3 |
| `e2e/redirect-hop.test.ts` | 25.1 | 1/3 |
| `e2e/session-window.test.ts` | 24.7 | 2/3 |
| `e2e/tab-close.test.ts` | 22.9 | 3/3 |
| `e2e/probe.test.ts` | 21.4 | 1/3 |
| `e2e/screenshot.test.ts` | 21.3 | 2/3 |
| `e2e/input.test.ts` | 21.2 | 3/3 |
| `e2e/session-restore.test.ts` | 19.8 | 1/3 |
| `e2e/settings-edit.test.ts` | 15.5 | 2/3 |
| `e2e/act.test.ts` | 14.1 | 1/3 |
| `e2e/act-settle.test.ts` | 13.8 | 3/3 |
| `e2e/wait-for.test.ts` | 13.8 | 3/3 |
| `e2e/network.test.ts` | 13.5 | 1/3 |
| `e2e/errors.test.ts` | 11.1 | 2/3 |
| `e2e/batch.test.ts` | 10.3 | 2/3 |
| `e2e/protected-get-form.test.ts` | 9.0 | 1/3 |
| `e2e/recipes-settings.test.ts` | 8.4 | 3/3 |
| `e2e/recording-after-approval.test.ts` | 8.1 | 3/3 |
| `e2e/console.test.ts` | 7.7 | 2/3 |
| `e2e/tab-strings.test.ts` | 7.5 | 1/3 |
| `e2e/upload-file.test.ts` | 6.9 | 1/3 |
| `e2e/session-stop.test.ts` | 6.8 | 2/3 |
| `e2e/page-text.test.ts` | 5.8 | 3/3 |
| `e2e/page-view.test.ts` | 5.5 | 3/3 |
| `e2e/download.test.ts` | 5.3 | 2/3 |
| `e2e/blocklist.test.ts` | 5.0 | 1/3 |
| `e2e/first-run.test.ts` | 4.7 | 3/3 |
| `e2e/indicator.test.ts` | 4.7 | 1/3 |
| `e2e/settings.test.ts` | 4.2 | 2/3 |

The 38 files took 1115.4 s together.

## The split over three shards (2026-11-21)

Dealt longest first, each file to the shard with the least time so far, the durations above
give (file names without `e2e/` and `.test.ts`):

| Shard | Files | Estimate (s) |
|---|---|---|
| 1/3 | `act`, `approval`, `blocklist`, `indicator`, `network`, `probe`, `protected-get-form`, `read-after-navigation`, `redirect-hop`, `session-restore`, `tab-strings`, `upload-file` | 372.0 |
| 2/3 | `batch`, `console`, `download`, `errors`, `network-burst`, `recipes`, `screenshot`, `session-end`, `session-stop`, `session-window`, `settings`, `settings-edit`, `tabs` | 371.7 |
| 3/3 | `act-settle`, `fill-form`, `first-run`, `foreign-file`, `foreign-file-restart`, `input`, `page-text`, `page-view`, `read-page`, `recipes-settings`, `recording-after-approval`, `tab-close`, `wait-for` | 371.7 |

The mean is 1115.4 / 3 = 371.8 s, so the largest shard is 1.001 times the mean. The longest
file, `approval` at 195.4 s, is shorter than the mean. The same durations dealt round-robin by
path, as `--test-shard` did, give 260.0, 188.5 and 666.9 s, close to the release steps of CI
run 44809266291 above.
