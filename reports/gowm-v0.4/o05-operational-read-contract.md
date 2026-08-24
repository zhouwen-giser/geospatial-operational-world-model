# O05 Operational Task Query and Timeline

## Decision

`PASS`

OperationalTask snapshots, immutable event timelines, correlation findings,
and candidates are exposed through a scope-bound, read-only SQL contract. The
Repository executes each query in a repeatable-read, read-only transaction and
returns a WorldVersion plus deterministic scope digest from that same snapshot.

## Implementation

- added `gowm_operational_reality_v1` views for task snapshots, task events,
  correlation findings, and correlation candidates;
- added transaction-local scope attestation and a snapshot context derived only
  from evidence visible in the selected DataScope;
- added a dedicated reader/service role with view/function access only, default
  read-only transactions, and no base-table or Foundation write access;
- added contract-validating Repository operations for bounded task search and
  stable event-time/receipt-time timeline ordering;
- filters by opaque task ReferenceKey, actor reference, and time range only
  after scope has been set inside the database transaction.

## Verification

- all 18 SQL assertion suites passed on real PostgreSQL;
- `018_operational_read_contract_assertions.sql` proves view isolation while
  changing scope in one transaction, timeline dual timestamps, snapshot digest,
  and actual denial of base-table and projector-function access to the reader;
- `npm run validate:operational-events` proves scoped ReferenceKey/actor/time
  search, contract-valid timeline output, cross-scope zero results, and a valid
  scope digest on the real event/projection/correlation dataset;
- `npm run verify`: pass — 97 Vitest tests passed, 1 intentionally skipped;
  all 39 STAS tests passed; TypeScript, SQL AST, and production builds passed.

The HTTP Provider runtime and Gateway registration consume this contract in
O09; no Provider is granted Foundation base-table access.

The locked C02 items AC-C007 and AC-C008 remain `BLOCKED_EXTERNAL`.
