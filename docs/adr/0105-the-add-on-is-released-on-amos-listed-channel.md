# 0105: The add-on is released on AMO's listed channel

**Status:** Accepted, 2026-11-23.

## Context

Until now each version of the add-on was signed for self-distribution, on AMO's unlisted
channel. AMO signed the file, the user fetched the `.xpi` from a GitHub release and installed it
by hand, and Firefox did not update it: each new version meant fetching and installing a file
again. Mozilla did not review such a version against a listing, because it had none.

The audience includes people who are not developers, for whom installing a file by hand is a
hurdle and keeping it current is easy to forget. Firefox installs a listed add-on from its page on
Firefox Add-ons with one click and keeps it up to date by itself.

The repository is public, so the notes to reviewers can name the source of the native host,
the `foxleash` program, instead of offering it on request.

## Decision

Every version of the add-on is submitted on AMO's listed channel (`web-ext sign --channel
listed`), with the source archive, the notes to reviewers (the body of the Permissions section of
`docs/amo/listing.md`) and the license given in that file's Listing details section. AMO's license
list has no slug for GPL-3.0-or-later, and `GPL-3.0-only` would misstate the license, so the
license goes as a custom license: a name and a short text that points at the full license in the
repository.

It lands in:

- `docs/development.md`, step 6 of Releasing: the listed channel, the license in the version
  metadata, the listing fields set on AMO before the first listed submission, and what to do
  when Mozilla's review outlasts web-ext's wait.
- `docs/amo/listing.md`: the Permissions paragraph about the native host, which names the public
  repository, and the Listing details section, which gives the slug, category, license, homepage
  and support site.
- `bin/setup-text.test.ts`: a test that the listing's slug is the last segment of
  `ADDON_PAGE_URL`, the address the program shows for the add-on, unless that address is the one
  by add-on id.

## Alternatives rejected

Staying self-distributed and adding an `update_url` to the manifest would let Firefox update the
add-on, but users would still install the first version by hand from a file, Mozilla would still
not review it, and the project would have to host and keep the update manifest itself.

Shipping the `.xpi` only on GitHub releases, without AMO, cannot work at all on release Firefox,
which installs only signed add-ons; with AMO's unlisted signing it is the procedure this record
replaces, with manual installs and manual updates.

## Consequences

Mozilla reviews each version against the listing, so drift between the listing, the manifest and
the extension's behaviour can get the add-on disabled. The listing rules in `AGENTS.md` and
the release check's `listing` subcommand exist for this.

A listed version can wait for Mozilla's review, beyond the time web-ext waits. The npm program is
published only after AMO serves the add-on version, as
[ADR 0072](0072-the-extension-serves-the-server-of-the-release-before.md) requires: a server
refuses an add-on older than itself.

Firefox updates users to each approved version without their action, so a version reaches every
user soon after review, and a defect does too.

The license goes as a custom license while AMO lists no GPL-3.0-or-later slug. When AMO adds one,
the Listing details section names it instead.

AMO takes a listed version only when the add-on has a name, a summary and categories on AMO, so
they are set before the first listed submission.
