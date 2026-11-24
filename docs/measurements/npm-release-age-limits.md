# npm release-age limits

Measurements behind [ADR 0072](../adr/0072-the-extension-serves-the-server-of-the-release-before.md).

## What npx does under a release-age limit (2026-11-24)

npm 11.16.0 on Node.js 24.18.1. Each command ran from an empty scratch directory, with
`--userconfig <scratch>/<file>` naming a user config that holds only the lines shown and
`--cache <scratch>/cache` a scratch npm cache. `npm notice` lines are left out.

| Command | User config | Result |
|---|---|---|
| `npm view foxleash time --json` | empty | `{"created": "2026-11-22T21:21:01.614Z", "modified": "2026-11-23T17:38:34.129Z", "0.0.0-stage": "2026-11-22T21:21:01.614Z", "0.6.0": "2026-11-22T21:23:09.515Z"}`, exit 0 |
| `npm view foxleash time --json` | `min-release-age=7`, `min-release-age-exclude[]=foxleash` | the same object, exit 0 (and `npm warn Unknown user config "min-release-age-exclude"` on stderr) |
| `npm view foxleash time --json` | `before=2026-11-01` | the same object, exit 0 |
| `npm view foxleash@0.6.0 dependencies peerDependencies optionalDependencies bundleDependencies --json` | empty | prints nothing, exit 0: no dependencies of any kind |
| `npx --yes foxleash@latest --help` | `before=2026-11-01` | `npm error code ENOVERSIONS`, `npm error No versions available for foxleash`, exit 1 |
| `npx --yes --min-release-age=0 foxleash@latest --help` | `before=2026-11-01` | the help text (`Usage: foxleash <command>` ...), exit 0 |
| `npx --yes foxleash@latest --help` | `min-release-age=7` | ENOVERSIONS, exit 1 |
| `npx --yes --min-release-age=0 foxleash@latest --help` | `min-release-age=7` | the help text, exit 0 |
| `npx --yes foxleash@latest --help` | `min-release-age=7`, `min-release-age-exclude[]=foxleash` | `npm warn Unknown user config "min-release-age-exclude"`, then ENOVERSIONS, exit 1 (npm 11.16.0 does not know the setting) |
| `npm view semver@latest version` | empty | `7.8.6` |
| `npx --yes semver@latest --help` | `before=2023-01-01` | first line `SemVer 7.3.8`, exit 0 |

So `npm view ... time` ignores both limits, a command-line `--min-release-age=0` clears both a
`min-release-age` and a `before` from the user config, and the package has no dependencies that
the override would let past the limit.

The semver run shows what npx installs when some versions are old enough: `npm view semver time
--json` gives 7.3.8 on 2022-10-04 and 7.4.0 on 2023-04-10, so `semver@latest` under
`before=2023-01-01` installs 7.3.8, the newest version published before the cutoff, not the
latest. In npm 11.16.0's `npm-pick-manifest/lib/index.js` (lines 97 to 104), an explicit tag whose
version is younger than the cutoff falls back to the range `<=<that version>`, and the range pick
filters by the cutoff (line 138). ENOVERSIONS comes only when no version at all is old enough, as
for foxleash, whose versions were all published on 2026-11-22.

## How npx picks a release (2026-11-24)

What npm 11.16.0 does with a package spec, read in its own code (paths relative to the npm
package):

- `node_modules/npm-package-arg` 13.0.2, `lib/npa.js` line 51: a bare name such as `foxleash`
  gets the spec `*`, a range. `foxleash@latest` is a tag spec.
- `node_modules/pacote` 21.5.0, `lib/registry.js` line 130: the pick gets the spec's fetchSpec
  (`*` or `latest`).
- `node_modules/@npmcli/config/lib/definitions/definitions.js` line 1479: `min-release-age=N`
  becomes `before = now - N days`; 0 means no limit.
- `node_modules/npm-pick-manifest` 11.0.3, `lib/index.js`:
  - lines 17 to 18 (`isBefore`): a version with no `time` entry counts as old enough.
  - lines 97 to 104: a tag spec returns the tagged version when it is old enough, deprecated or
    not, and otherwise picks from the range `<=<tagged version>`.
  - lines 115 to 132: the range `*` returns the `latest` version only when it is listed, old
    enough, engine-compatible and not deprecated.
  - lines 135 to 149: the candidates are the listed versions that are old enough; none is
    ENOVERSIONS.
  - lines 151 to 182: candidates are filtered with `semver.satisfies` without
    `includePrerelease`, so prereleases such as `0.0.0-stage` drop out, and ranked: not
    deprecated and engine-compatible first, then engine-compatible, then not deprecated, then
    the highest version. `deprecated` counts when it is truthy, so an empty message is no
    deprecation.

So the release npx installs is not always the newest one published before the cutoff: a version
missing from `versions` is never picked, a deprecated one is picked last, `latest` bounds the tag
spec, and a version published inside the window on an older line can outrank a deprecated newer
one only for limits short enough to see it.

The commands that give npm's `versions`, `time`, `dist-tags` and each version's `deprecated`.
npm 11.16.0 on Node.js 24.18.1, the same setup as above; `before.npmrc` holds `before=2026-11-01`,
`age.npmrc` holds `min-release-age=7` and `before2025.npmrc` holds `before=2025-01-01`. Outputs
are shown with whitespace collapsed and long deprecation messages shortened with `...`.

| Command | User config | Result |
|---|---|---|
| `npm view foxleash versions time dist-tags --json` | empty, `before=2026-11-01`, `min-release-age=7` (each) | exit 0, one object keyed by field name: `{"versions": ["0.0.0-stage", "0.6.0"], "time": {"created": "2026-11-22T21:21:01.614Z", "modified": "2026-11-23T17:38:34.129Z", "0.0.0-stage": "2026-11-22T21:21:01.614Z", "0.6.0": "2026-11-22T21:23:09.515Z"}, "dist-tags": {"latest": "0.6.0"}}` |
| `npm view 'foxleash@>=0.0.0' version deprecated --json` | empty | exit 0, `"0.6.0"` (a bare string) |
| `npm view 'foxleash@*' version deprecated --json` | empty | exit 0, `"0.6.0"` |
| `npm view 'foxleash@>=0.0.0' name version deprecated --json` | empty, `before=2026-11-01`, `min-release-age=7` (each) | exit 0, one object `{"name": "foxleash", "version": "0.6.0"}` |
| `npm view foxleash@0.6.0 deprecated --json` | empty | exit 0, prints nothing |
| `npm view 'uuid@>=0.0.0' version deprecated --json` | empty | exit 0, an array of objects, first `{"version": "0.0.1", "deprecated": "uuid@10 and below is no longer supported. ..."}` |
| `npm view 'uuid@^11' version deprecated --json` | empty | exit 0, `["11.0.0", "11.0.1", "11.0.2", "11.0.3", "11.0.4", "11.0.5", "11.1.0", "11.1.1"]`: version strings only, because the first entry had one key |
| `npm view 'uuid@^11' name version deprecated --json` | empty, `before=2025-01-01` (each) | exit 0, the same eight versions as `[{"name": "uuid", "version": "11.0.0"}, ...]`; 11.0.5 (2025-01-09T22:40:18.873Z), 11.1.0 (2025-02-19T18:16:11.602Z) and 11.1.1 (2026-04-29T15:17:24.795Z) are listed under `before=2025-01-01` too |
| `npm view 'uuid@10.0.0 \|\| 11.0.0' version deprecated --json` | empty | exit 0, `[{"version": "10.0.0", "deprecated": "uuid@10 and below ..."}, {"version": "11.0.0"}]`: a live version has no `deprecated` key |
| `npm view uuid@3.4.0 name version deprecated --json` | empty | exit 0, one object `{"name": "uuid", "version": "3.4.0", "deprecated": "uuid@10 and below ..."}` |
| `npm view uuid@3.4.0 deprecated --json` | empty | exit 0, the message as a JSON string |
| `npm view 'uuid@^11' deprecated --json` | empty | exit 0, prints nothing (0 bytes) |
| `npm view 'uuid@>=999.0.0' name version deprecated --json` | empty | exit 1, `npm error code E404`, `npm error 404 No match found for version >=999.0.0` (and a JSON `{"error": {"code": "E404", ...}}` on stdout) |

Why these shapes, in `lib/commands/view.js`:

- lines 141 to 149: a spec whose raw part is `*` (also `foxleash@*`) shows only the version the
  `tag` config names, `latest`, so the deprecations of other versions need a range such as
  `>=0.0.0`.
- lines 174 to 175: the versions shown are the listed ones that satisfy the range loosely, so
  prereleases drop out. Each field is read from the version's manifest over the packument
  (`showFields`, from line 418), which is why `versions`, `time` and `dist-tags` come from the
  packument.
- lines 161 to 167: `versions` leaves out a key that is not a valid version; prereleases stay.
- lines 190 to 196: a range that matches nothing is E404, except for the name `latest`. So
  `npm view foxleash versions time dist-tags --json` prints nothing, exit 0, when there is no
  `latest` dist-tag, and fails with E404 `No match found for version <L>` when `latest` names a
  version npm does not list.
- lines 246 to 252: with `--json`, when the first entry has one key every entry is unwrapped to
  that key's value, one entry prints alone rather than in an array, and no entry prints nothing.
  With `name` in the fields, every entry has at least two keys, so no unwrapping drops the
  deprecations.

`npm run check:release -- protocol` runs `npm view foxleash versions time dist-tags --json` and
`npm view 'foxleash@>=0.0.0' name version deprecated --json`, fails on any other output shape or
when the two list different versions, and works out the pick of `npx foxleash setup` and
`npx foxleash@latest setup` with the rules above at the 14-day cutoff and at every publish since,
assuming a Node.js that satisfies every release's `engines.node`.

## Older npm versions (2026-11-24)

The same setup, each npm started through npx
(`npx --yes --userconfig <scratch>/empty.npmrc --cache <scratch>/cache npm@<version> ...`), the
inner command given its own `--userconfig`.

| npm | Command | User config | Result |
|---|---|---|---|
| 11.6.0 | `npm config get min-release-age` | empty | `undefined`: the setting does not exist |
| 11.9.0 | `npm config get min-release-age` | empty | `undefined` |
| 11.10.0 | `npm config get min-release-age` | empty | `null`: the setting exists, unset |
| 11.6.0 | `npm exec --yes foxleash@latest -- --help` | `before=2026-11-01` | ENOVERSIONS, exit 1 |
| 11.6.0 | `npm exec --yes --min-release-age=0 foxleash@latest -- --help` | `before=2026-11-01` | `npm warn Unknown cli config "--min-release-age"`, then ENOVERSIONS, exit 1 |
| 11.6.0 | `npm exec --yes --before=2099-01-01 foxleash@latest -- --help` | `before=2026-11-01` | the help text, exit 0 |
| 11.16.0 | `npx --yes --before=2099-01-01 foxleash@latest --help` | `min-release-age=7` | the help text, exit 0 |

npm 11.10.0 is the first release that knows `min-release-age`. On an older npm only `before` can
be set, and `--before=<a later date>` overrides it.

## Mixing the two settings (2026-11-24)

The same setup, npm 11.10.0 to 11.16.0 started through npx as above, each running
`npm exec --yes --userconfig <scratch>/<file> --cache <scratch>/cache <flag> foxleash@latest -- --help`
with a user config that holds one line, `before=2026-11-01` or `min-release-age=7`:

| npm | User config | Flag | Result |
|---|---|---|---|
| 11.10.0, 11.12.0, 11.14.0, 11.14.1 | `before=2026-11-01` | `--min-release-age=0` | `--before cannot be provided when using --min-release-age`, exit 1 |
| 11.10.0, 11.12.0, 11.14.0, 11.14.1 | `min-release-age=7` | `--before=2099-01-01` | `--min-release-age cannot be provided when using --before`, exit 1 |
| 11.10.0, 11.12.0, 11.14.0, 11.14.1 | `min-release-age=7` | `--min-release-age=0` | the help text, exit 0 |
| 11.10.0, 11.14.1 | `before=2026-11-01` | `--before=2099-01-01` | the help text, exit 0 |
| 11.15.0, 11.16.0 | either | either | the help text, exit 0 |

So the flag that matches the user's setting works on every npm that knows the setting, and from
npm 11.15.0 on either flag overrides both settings.

## npm 11.21.2 (2026-11-24)

npm 11.21.2 on Node.js 24.17.0, with `min-release-age=7` and `min-release-age-exclude[]=foxleash`
in the user config:

| Command | Result |
|---|---|
| `npx foxleash@latest --help` | ENOVERSIONS |
| `npx --min-release-age=0 foxleash@latest --help` | the help text |

The exclude list does not reach npx: in npm 11.21.2 it is read only by the install, update,
audit, outdated, pack and query commands (`minReleaseAgeExclude` in `npm/lib/commands`), not by
exec, pacote or npm-pick-manifest.
