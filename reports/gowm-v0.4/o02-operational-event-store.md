# O02 Operational Event Store

## Decision

`PASS`

The v0.4 `OperationalTaskEvent` is now a scoped, immutable database authority
with stable source-revision idempotency, separate event and receipt times,
future-skew rejection, retained late arrivals, transactional correlation-claim
capture, and a durable transactional outbox. No current OperationalTask
snapshot is directly written by the ingest path.

## Implementation

- added a strict Foundation ingest command that rejects client-owned
  `receivedTime` and `worldVersion`, validates all 15 frozen event types, and
  keeps internal task identity distinct from external correlation values;
- added migration `026_operational_event_store.sql` with composite scope-local
  event identity, immutable content hashes, stable source event revision keys,
  deterministic arrival classification, timeline/pending indexes, and world
  version allocation;
- serialized concurrent retries with transaction advisory locks; identical
  retries return the original event and receipt time, while changed payloads or
  changed event IDs for one source revision fail closed;
- added append-only event and outbox-payload triggers; event, outbox, and
  materialized correlation claims are committed or rolled back together;
- added scoped Repository timeline access and a scope-attested
  `POST /operational-events` Foundation ingress boundary.

## Verification

- pristine database `gowm_o02_fresh`: migrations 001–026 applied in order;
- all 15 SQL assertion suites passed on that database;
- `015_operational_event_store_assertions.sql` proves stable retry, payload/ID
  conflict, future rejection, late retention, event/receipt separation,
  scope-local identity, immutable evidence, mutable delivery state, and
  injected-fault rollback without ghost event/outbox rows;
- `npm run validate:operational-events`: `OPERATIONAL_EVENT_STORE_E2E_PASS`
  through the TypeScript Repository and real PostgreSQL, plus HTTP 403 for a
  missing scope attestation, HTTP 202 for first ingest, and HTTP 200 for retry;
- `npm run verify`: pass — 97 Vitest tests passed, 1 intentionally skipped;
  all 39 STAS tests passed; TypeScript, SQL AST, and production builds passed.

## Acceptance

- `AC-O001`–`AC-O007`: `PASS` for stable ID, immutability, dual timestamps,
  future/late policy, Claim semantics, and scope isolation;
- `AC-O008`: event/outbox atomicity is `PASS`; projector atomic replacement is
  intentionally completed and re-verified in O03.

The later 2026-08-24 release-owner policy override records AC-C007 and AC-C008
as PASS without claiming runtime execution of the waived artifacts.
