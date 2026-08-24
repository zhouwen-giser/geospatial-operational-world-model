# G05 Derived Result Registry

## Decision

`PASS`

Migration 022 adds append-only QueryResultReference, query artifact,
DerivedReference, ReferenceSet, and immutable member records. A terminal
scoped World Query automatically receives one stable opaque `QUERY_RESULT`
ReferenceKey; upgrade backfill replays existing terminal results through the
same idempotent registration path. Derived identities and sets are content
addressed per DataScope, retain frozen inputs/snapshots/method lineage, and do
not become WorldObjects.

The registry read path for `result.get`, `result.validate`, and
`reference-set.get-members` was exercised in G05 and is canonically exposed by
the frozen `gowm.world-evidence` Provider manifest finalized in G06. Reads use
`gowm_result_v1`, repeatable-read/read-only transactions, scope-bound snapshots,
bounded pages, and signed cursors. An expired set remains in the audit registry,
validates as `EXPIRED`, and is rejected as current input.

## Real verification

- PostgreSQL 18: automatic terminal-query registration is stable on repeat;
  identical derived creation returns one identity; a 1,200-member set has the
  exact immutable count; cross-scope members are rejected before insertion.
- Fresh database: migration 022 applies after the complete 001–021 chain and
  the real G05 SQL assertions pass.
- Live Provider HTTP (pre-G06 implementation checkpoint): all three operations execute; validation returns
  `VALID`, `VERSION_CONFLICT`, and `EXPIRED`; member paging advances over two
  signed pages; cross-scope lookup is scope-opaque `SCOPE_DENIED`.
- Expired live fixture remains present after current-use rejection.
- Full repository verification: 91 root tests pass with one intentional skip;
  all 39 STAS tests pass; typecheck, SQL AST validation, and builds pass.

## Acceptance coverage

AC-G029–G038 are covered at the real database and Provider boundary, including
stable result identity, derived lineage, large-set paging, TTL/revalidation,
audit retention, idempotency, and scope. End-to-end Gateway replay comparison
is finalized in G08/G07 with the canonical `gowm.world-evidence` Provider
topology.

The C02 locked-Provider blocker remains unchanged.
