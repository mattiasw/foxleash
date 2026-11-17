# 0079: A batch joins a role-only read_page step after a find step

**Status:** Accepted, 2026-11-18. Amends [0068](0068-read-page-takes-role-without-find.md): its rule that a run whose first step has `find` takes only steps with `find` is dropped.

## Context

[0068](0068-read-page-takes-role-without-find.md) let `batch` join role-only `read_page` steps into one request with `finds`, but kept a run whose first step has `find` from taking a step without `find`. An extension from before 0068 refuses a `finds` entry without `find`, and that refusal would fail the run's first step, a find that succeeds when it runs alone. Its Consequences named the next `PROTOCOL_VERSION` bump as the point to drop the condition.

The protocol has since been raised to 6 and to 7, both after 0068. Under [0072](0072-the-extension-serves-the-server-of-the-release-before.md) the server gives no oldest protocol, so the host refuses an extension on an older protocol than the server's own. Every extension a server can meet therefore knows role-only `finds` entries, and the condition protects against nothing.

## Decision

A `read_page` step with a string `find` or a string `role` joins a run under [0056](0056-a-batch-reads-consecutive-finds-in-one-walk.md)'s other conditions, whatever the run's first step has: one tab, the same `filter`, `depth` and `ref`, no `find` or `role` that is only spaces, and each `find`, `role` and `ref` at most 1,000 characters. Each step after the first goes into `finds` with only the keys it has. The change is in `findsJoin` in `apps/server/src/tools.ts`.

`PROTOCOL_VERSION` stays 7: the server sends no shape the protocol does not already have, since a run that starts with a role-only step already sends role-only `finds` entries.

## Alternatives rejected

- **Keeping the condition.** A batch `[find, role]` would walk the page twice for no remaining reason.
- **Raising the protocol version.** No message shape changes, and the version has already been raised twice since 0068.

## Consequences

- A batch `[find, role]` or `[find and role, role]` takes one walk, as `[role, find]` already does.
- An extension must keep accepting role-only `finds` entries for every protocol it serves, which 0072's rules already require.
