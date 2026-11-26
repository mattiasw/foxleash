# 0108: A safeguard claim may be stated in the security document instead of the listing

**Status:** Accepted, 2026-11-26.

## Context

`docs/amo/listing-claims.json` ties each safeguard to evidence in the code, and the release check
(`npm run check:release -- listing`) required every safeguard claim to occur word for word in
`docs/amo/listing.md`, with a claim in every item of the privacy policy's list of safeguards.
Mozilla disables add-ons whose listing and behaviour disagree, so each of those sentences carried
its exceptions. That check, not Mozilla, set the length of two sections: the notes to reviewers
held 2,991 of the 3,000 characters AMO takes, and the privacy policy 2,511 words, 996 of them
safeguards and exceptions that `docs/security.md` already states in full.

Mozilla asks for less. Its submission guide wants a privacy policy "explaining what is being sent
and how it’s used" and notes to reviewers that are "information to assist the AMO reviewer". Its
Add-on Policies, also as they read from 1 December 2026, want "an easy-to-read description of
what the add-on does, and what information it transmits" and, for the reviewer, "testing
information". Neither asks for a safeguard's exceptions in the listing.
[0104](0104-the-manifest-declares-three-data-categories.md) and
[0105](0105-the-add-on-is-released-on-amos-listed-channel.md) record what the two sections must
carry besides.

## Decision

The privacy policy says what is sent, where it goes, how it is used and what is stored, and links
`docs/security.md` for the safeguards and their exceptions. The notes to reviewers give one use
per permission and say how to get a working setup.

A safeguard claim passes when it occurs word for word, with whitespace flattened, in
`docs/amo/listing.md` or in `docs/security.md`. A claim whose statement left the listing names a
sentence of the security document and keeps its evidence. Capability claims still occur only in
the listing's capability list, and every item of the Description's "What protects you:" list
still needs a safeguard claim.

The Data collection and handling section must hold the link
`https://github.com/mattiasw/foxleash/blob/main/docs/security.md` as a word of its own, without a
fragment, and no `<`: markup could hide the link or point it elsewhere.

It lands in `checkClaimsOccur` and `checkSecurityDocLinked` in `bin/check-release.ts`, in
`docs/amo/listing-claims.json` and in those two sections of `docs/amo/listing.md`.

## Alternatives rejected

- **Removing a claim together with the statement the listing no longer makes.** The statement
  still exists, in `docs/security.md`, where users and reviewers are now sent for what a safeguard
  promises. It would drift from the code unchecked, just when it became the full statement.
- **Requiring a claim in every section of `docs/security.md`.** Several sections describe limits
  and no safeguard, so the check would need a list of exempt sections: one more thing to
  maintain, for a weak guarantee.

## Consequences

- A sentence of `docs/security.md` that a claim names cannot change without the claim, in the
  same commit.
- The check is textual. It shows that the sentence exists in the file's source, not where a
  reader meets it: a claim inside a comment or a code block would count, and a sentence that
  occurs twice lets one copy change unchecked. The two files are searched apart, so no claim
  matches across the end of one and the start of the other.
- The listing no longer states most safeguards, so `docs/security.md` must stay a tracked
  regular file at the linked address. When it is not, the check fails and counts claims in the
  listing alone.
- The link points at the main branch, so the document can describe a safeguard that the
  released version does not have yet, where the policy text used to be fixed at the release's
  tag. The privacy policy says so.
- No check asks for a claim when a new safeguard is written into `docs/security.md`, and none
  notices a claim that is removed while its sentence stays: the list that needed one claim per
  item is gone. The rules in `AGENTS.md` cover both: a new safeguard updates the claims file, and
  a safeguard that no longer holds is a listing change.
