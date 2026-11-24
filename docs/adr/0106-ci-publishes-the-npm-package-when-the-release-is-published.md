# 0106: CI publishes the npm package when the GitHub release is published

**Status:** Accepted, 2026-11-24.

## Context

The npm package `foxleash` was published by hand from the release machine's `apps/server/dist`,
with a token of the maintainer's account. Nothing compared that build with CI's, and nothing
recorded where a published version came from.

A server refuses an add-on older than itself, so a release makes its server available only once
its add-on version can be installed; for a listed version, once AMO serves it publicly
([0072](0072-the-extension-serves-the-server-of-the-release-before.md)). Mozilla's review of a
listed version can take days. The release process creates the draft GitHub release only once
AMO serves the signed version, and the maintainer then publishes it.

## Decision

- `.github/workflows/publish.yml` publishes the package when a GitHub release is published, and
  on nothing else. The event names the tag, and the provenance names the tagged commit.
- npm's trusted publishing, with a trusted publisher bound to this repository, the workflow file
  and the GitHub environment `npm`, which only `v*` tags may use. No npm token is stored
  anywhere, and npm attaches provenance.
- Only the job that runs no project code gets the identity token. The `build` job reads the
  repository and runs everything: `npm ci`, `check:release -- tag` (the tag is the version of
  every version field and HEAD's commit, on origin's `main`), a wait of up to 30 minutes for AMO
  to serve the version publicly, the gates, the build and `npm pack`. The `publish` job runs no
  checkout, install or npm script.
- `publish` checks the tag again from the event, and the tarball with `tar` and `jq`: exactly one
  `foxleash-<version>.tgz` holding exactly the five package files as regular files, and a
  `package.json` with the name `foxleash` and the tag's version, no `publishConfig` (which could
  send the publish to another registry) and no `scripts`. GNU tar and npm can read one crafted archive
  differently, so `publish` packs the files it checked again with `npm pack`, checks that
  tarball and publishes it.

## Alternatives rejected

- **Publishing on the tag push and waiting for AMO.** A review can outlast the 6 hours a
  GitHub-hosted job may run, and a job that timed out needs someone to re-run it: the manual step
  this removes.
- **A stored npm token.** It is a long-lived secret that publishes from wherever it leaks to;
  trusted publishing gives each run a short-lived token that only this workflow and environment
  can obtain.
- **Publishing by hand from the release machine.** The published package would not be CI's
  build, and no provenance would link it to a commit.

## Consequences

- The checks guard against a release published by mistake: a tag off `main`, a tag that is not
  the package's version, a version AMO does not serve yet, a tarball npm would act on
  differently. A failed run is re-run from the Actions page and replays the same event.
- Who can publish is bounded by write access to the repository and the environment's `v*` rule:
  a tag's own commit supplies the workflow, so someone who can push a `v*` tag can change what
  the workflow does. A tag moved onto a later commit of `main` with the same version is not
  detected; the release tag is already on origin by the time AMO serves the version.
- The bundle is as trustworthy as the `build` job, which runs the development dependencies, and
  the provenance names that build.
- A version npm already has cannot be published again, so a re-run after a successful publish
  fails.
- Version 0.6.0 went out by hand, before this workflow.
