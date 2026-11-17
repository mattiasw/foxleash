# 0075: The release artifacts are the bytes of the tagged commit

**Status:** Accepted, 2026-11-17.

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

## Alternatives rejected

- Rebuilding the XPI from the archive inside the check. It needs `npm ci` and the network on
  every `pre-push`, and `build:amo` already does that rebuild.
- Reading the shipped files from the index. Another session's staged edit would still ship.
- Leaving the archive's `README.md` uncompared because it holds the build machine's versions. Any
  text would pass, including instructions telling reviewers to build differently.

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

The checks do not compare the XPI's bytes, only its manifest version: the XPI is bound to the
archive by the `build:amo` run that wrote both. An XPI separated from its archive afterwards,
such as a stale copy left in a `--dir` folder, is caught only by its version. The checks judge the
tag's tree by the ship rules of the checkout they run in, and fail where those rules disagree
with the tag's `bin/amo-source-files.txt`, which `build:amo` made the tag's archive match: a
checkout whose rules changed since the tag fails a correct archive rather than passing a wrong
one.
