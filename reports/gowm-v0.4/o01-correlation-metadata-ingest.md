# O01 Correlation Metadata Ingest

## Decision

`PASS`

The canonical v1.2 Observation input and the internal WorldEvent envelope now
preserve the six v0.4 correlation metadata fields. Persistence creates scoped,
append-only `ExternalCorrelationClaim` evidence automatically; no propagated
value is promoted to a GOWM reference identity or other internal truth.

## Implementation

- accepted and length-bounded `executionIntentId`,
  `operationCorrelationId`, `externalPlanningTaskId`,
  `externalPlanningStepId`, `providerActionId`, and `deviceCommandId`;
- retained those fields through normalization, immutable payload hashing,
  Observation persistence, ObservationReceived WorldEvent creation, event
  persistence, and row mapping;
- added migration `025_external_correlation_claims.sql` with scoped correlation
  columns, migration-time WorldEvent scope backfill, append-only Claim storage,
  lookup indexes, and automatic Observation/WorldEvent capture triggers;
- recorded claim authority, kind, value, relation hint, match basis, confidence,
  observed/received times, source evidence IDs, and a content hash;
- made Claim replay idempotent per scoped source and deliberately allowed the
  same external identifier to be claimed by multiple evidence records.

## Verification

- `npm run verify`: pass — 94 Vitest tests passed, 1 intentionally skipped;
  all 39 STAS tests passed; TypeScript, SQL AST, and production builds passed;
- pristine database `gowm_o01_fresh`: migrations 001–025 applied in order;
- pristine database: all 14 SQL assertion suites passed;
- `014_external_correlation_claim_assertions.sql` proves six-field capture,
  WorldEvent retry deduplication, one-to-many external task claims, scoped
  isolation, evidence timestamps, match-basis mapping, and update/delete
  rejection;
- canonical Observation unit coverage proves correlation propagation, payload
  hash sensitivity, stable internal Observation identity, and 512-character
  input bounds.

## Acceptance

- `AC-O006`: `PASS` — propagated fields create claims, not truth;
- `AC-O007` (event/claim portion): `PASS` — stored fields and claims are
  explicitly scoped and tested against cross-scope leakage.

The two locked C02 external-evidence items remain `BLOCKED_EXTERNAL`; O01 does
not alter their status.
