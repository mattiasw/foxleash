# 0075: The release artifacts are the bytes of the tagged commit

**Status:** Accepted, 2026-11-17.

Amended 2026-11-21: `built` compares a digest of the XPI's files with the one CI's `validate` job
printed for the tag's commit.

## Context

Mozilla signs the XPI we upload and keeps the source archive we attach; both must be what the
release tag says they are. `npm run build:amo` listed the shipped files from the git index but
copied their bytes from the working tree, read the README template from the working tree, and
the release checks only looked for the two files and the XPI's manifest version. One line
appended to `apps/extension/src/background.ts` while `build:amo` ran, and removed afterwards,
ended up in both the XPI's `background.js` and the archive's `background.ts`, while HEAD did not
have it, the tree was clean again and `pre-push` reported nothing about the artifacts. The clean
rebuild and its `diff -r` only showed that the XPI matched the archive and the checkout build,
and both had seen the same edited tree.

## Decision

`bin/build-amo.ts` resolves HEAD to one commit at the start and reads the shipped files
(`git ls-tree -r` of that commit, `git cat-file blob` for each file, written byte for byte), the
README template and `bin/amo-source-files.txt` from that commit, never from the working tree or
the index. Its git calls pass `--no-replace-objects`, so a replace ref cannot change the bytes. A
shipped path must be a plain relative name (`SHIPPED_NAME`, with no `.`, `..` or empty segment),
so no tree entry can write outside the build folder or become an unzip option. The checkout build
and the comparison of the two builds stay: the clean copy now builds the commit's bytes, so a
working tree that builds differently fails the comparison and no artifacts are written. That
comparison is what binds the XPI to the archive. Both files reach `artifacts/` in one `rename`
of a folder, so two runs at once cannot leave a mixed pair.

`bin/check-release.ts` compares the source archive with the commit of the tag `v<version>` in
`pre-push` and in the new `built <version> [--dir <path>]`, which the signing step runs on the
copies it signs: the archive holds exactly the files that commit ships by the rules of
`bin/build-amo.ts`, byte for byte, and a `README.md` that is the commit's template with some
`x.y.z` Node and npm versions filled in (`readmePattern`). Each extra, missing or differing file
is a FAIL naming the file and the commit.

`build:amo` also prints a digest of the extension's files, the sha256 of one `<sha256>  <path>`
line per file in byte order of the path, and `built` computes it over the XPI's file entries: it
must equal the digest the `validate` job printed in each successful `ci.yml` run on `main` for the
tag's commit, and at least one must have printed it.

## Alternatives rejected

- Rebuilding the XPI from the archive inside the check. It needs `npm ci` and the network on
  every `pre-push`, and `build:amo` already does that rebuild.
- Reading the shipped files from the index. Another session's staged edit would still ship.
- Leaving the archive's `README.md` uncompared because it holds the build machine's versions. Any
  text would pass, including instructions telling reviewers to build differently.
- Uploading CI's XPI as a workflow artifact and comparing with it: another action to pin, for no
  gain, since artifacts and logs expire under the same retention setting.
- Comparing builds on one machine only, as `build:amo`'s `diff -r` does: it cannot show that a
  second machine builds the same files.

## Consequences

`build:amo` builds only committed work: uncommitted changes, staged or not, are not in the
archive, and a working tree whose shipped files build differently from HEAD fails. CI runs it on
a clean checkout and the release runs it after the bump commit, so both keep working.

The check compares the bytes of regular entries as `unzip -p` prints them and the README against
the template, not zip metadata or entry types. Archive entries carry the mode `writeFile` gives
(0644 under the usual umask), where copying kept the checkout's; no shipped file is executable.
A crafted archive, such as a symlink entry whose stored target text equals the committed bytes,
would pass, but making one needs write access to the release checkout's `artifacts/`, outside
what this closes.

`pre-push` checks only the XPI's manifest version: the `build:amo` run that wrote both binds the
XPI to the archive. `built`'s digest covers the files' names and bytes, not the zip's, whose
timestamps differ between machines, so a stale or foreign XPI in a `--dir` folder fails. It
trusts every process of the `validate` job: one that runs before `build:amo`, such as a
dependency's install script, could print another digest line and hide the real one with
`::add-mask::`. It also needs that job's log: GitHub deletes it after the repository's retention
period and reruns a run only within 30 days of it, so a release whose log is gone after that
needs a new version. The checks judge the tag's tree by the ship rules of the checkout they run
in, and fail where those rules disagree with the tag's `bin/amo-source-files.txt`, which
`build:amo` made the tag's archive match: a checkout whose rules changed since the tag fails a
correct archive rather than passing a wrong one.
