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
