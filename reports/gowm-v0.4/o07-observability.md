# O07 Operational Observability

## Decision

`PASS`

Operational observability is now a first-class, immutable assessment built from
separate source-health, watermark, coverage, observation, and explicit-gap
evidence. A present observation is not treated as sufficient coverage, and an
unhealthy source prevents a negative predicate conclusion.

## Implementation

- added append-only source-health and source-watermark revisions;
- added scope-bound coverage evidence and explicit observation-gap intervals;
- added deterministic, WorldVersion-pinned observability assessments with
  evidence snapshots and input/result hashes;
- implemented distinct `FRESH`, `STALE`, `OBSERVATION_GAP`, `NO_DATA`,
  `SOURCE_UNHEALTHY`, and `INDETERMINATE` decisions;
- added a contract-validating Repository and a scope-filtered read-only view;
- embedded the assessment in new PredicateEvaluation records and demoted
  `NOT_SUPPORTED` to `INDETERMINATE` whenever source health, watermark, or
  coverage prerequisites are not satisfied.

## Verification

- `020_operational_observability_assertions.sql` passes on real PostgreSQL and
  proves fresh/stale/gap/unhealthy/insufficient states, explicit gap intervals,
  coverage separation, cross-scope denial, and append-only enforcement;
- the O06 predicate SQL suite still passes with first-class observability
  gating and requires a `FRESH`, coverage-sufficient assessment for its negative
  case;
- focused TypeScript tests cover all public assessment statuses and request
  bounds;
- `npm run validate:operational-events` proves fresh, stale, explicit-gap, and
  unhealthy-source decisions over the real event store, and returns the source
  health assessment inside PredicateEvaluation.
- `npm run verify`: pass — 114 Vitest tests passed, 1 intentionally skipped;
  all 39 STAS tests passed; TypeScript, SQL AST, and production builds passed.

The later 2026-08-24 release-owner policy override records AC-C007 and AC-C008
as PASS without claiming runtime execution of the waived artifacts.
