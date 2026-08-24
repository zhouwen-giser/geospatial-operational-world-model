# G07 Grounding Security and Replay

## Decision

`PASS`

Migration 024 adds an append-only Grounding replay audit with the required
policy version, source evidence range, input/evidence hash, expected and replay
checksums, outcome, and structured difference report. Reference Search
Projection rebuilds are checksummed before and after rebuilding. Frozen Query
Result replays are classified as `MATCH`, `DATA_VERSION_DIFFERENCE`,
`COMPUTE_VERSION_DIFFERENCE`, or `CHECKSUM_MISMATCH`; a changed result is never
accepted as a match merely because replay completed.

The reusable `validate:grounding-security` adversarial runner covers all three
Grounding Providers without embedding credentials. It checks scope-opaque
lookups, candidate-count non-disclosure, input bounds, injection-as-data,
authenticated transport, and signed cursor binding to operation, DataScope,
DatasetScope, and evidence snapshot.

## Real verification

- Live Provider adversarial run: Reference, Dataset, and Query Result keys from
  another DataScope are indistinguishable from random opaque keys; hidden
  Reference search returns `UNRESOLVED`, zero candidates, and zero candidate
  consumption.
- A 513-character mention fails frozen-schema validation. SQL-looking input is
  treated only as a search string and the Provider remains ready.
- Modified cursor signatures, cross-Scope cursor reuse, and cross-operation
  cursor reuse all fail as `INVALID_REQUEST` before data is returned.
- Unauthenticated Provider transport is rejected.
- Real replay audit: the first Reference projection rebuild recorded
  `REBUILT_DIFFERENCE`, the unchanged second rebuild recorded `MATCH`; an exact
  frozen Query Result replay recorded `MATCH`, while a changed data snapshot
  recorded `DATA_VERSION_DIFFERENCE` with both versions in the difference
  report.
- Fresh database: migrations 001–024 and all thirteen SQL assertion files pass.
  The assertions also corrupt and repair a projection, distinguish a same-input
  checksum mismatch, enforce scope isolation, and reject audit mutation.
- Full repository verification: typecheck, SQL AST validation, root/STAS tests,
  and builds pass.

## Acceptance coverage

AC-G038 security/replay obligations are now backed by durable real-database
evidence. G01–G07 scope, immutability, bounded-search, TTL, cursor, and late-data
controls were rerun together. AC-G046–G048 remain for the G08 real Gateway DAG,
architecture scan, and final Grounding compatibility gate.

The C02 locked-Provider blocker remains unchanged.
