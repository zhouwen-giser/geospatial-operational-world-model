# O03 Operational Task Projection

## Decision

`PASS`

OperationalTask current state is now an atomically replaced, fully rebuildable
projection of immutable `OperationalTaskEvent` evidence. The projection keeps
control, observed activity, physical outcome verification, and observability as
four independent dimensions and assigns an opaque GOWM OperationalTask
ReferenceKey without adopting an external planning identifier.

## Implementation

- added migration `027_operational_task_projection.sql` with immutable policy,
  internal task identity, projection-owned current snapshot, durable queue, and
  append-only projection audit;
- resolves each dimension independently using event time, source priority,
  confidence, and stable event ID tie-break; receipt time remains evidence but
  cannot make late evidence override a newer event-time winner;
- `CONTROL_COMPLETED_REPORTED` establishes `COMPLETED_REPORTED` plus
  `UNVERIFIED`; only explicit physical evidence can produce
  `PARTIALLY_VERIFIED`, `VERIFIED`, or `CONTRADICTED`;
- gap events update observability without fabricating an activity or outcome;
- every semantic snapshot change allocates a new monotonic WorldVersion and an
  immutable audit record; no-change replay preserves the existing version;
- shared live/replay computation produces hashes that can be compared without
  trusting the mutable current table;
- integrated pending OperationalTask projection into the existing Foundation
  projection worker and added a contract-validating Repository mapper.

## Verification

- all 16 SQL assertion suites passed on the real PostgreSQL verification DB;
- `016_operational_projection_assertions.sql` proves all four dimensions,
  completed-but-unverified, explicit physical confirmation, later
  contradiction, gap semantics, late non-regression, source priority, stable
  event-ID tie-break, monotonic WorldVersion, projection ownership, audit
  immutability, and live/replay hash equality;
- injected cross-scope identity failure retains its immutable source event and
  pending queue row while creating no partial snapshot or mutation in the valid
  scope;
- `npm run validate:operational-events` proves real HTTP → Repository → event
  store → queue → four-dimensional snapshot → full replay with equal hashes;
- `npm run verify`: pass — 97 Vitest tests passed, 1 intentionally skipped;
  all 39 STAS tests passed; TypeScript, SQL AST, and production builds passed.

## Acceptance

`AC-O008`–`AC-O018` are `PASS`. One-to-many external task correlation
(`AC-O019`) remains assigned to O04, where the resolver and finding evidence are
implemented.

The locked C02 items AC-C007 and AC-C008 remain `BLOCKED_EXTERNAL`.
