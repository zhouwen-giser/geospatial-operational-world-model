# O06 External Predicate Evaluation

## Decision

`PASS`

External predicates are validated query inputs and never become World facts.
Evaluation is scope-bound, evidence-backed, idempotent, append-only, and frozen
at a WorldVersion. Absence, insufficient coverage, explicit contradiction, and
conflicting evidence remain distinct outcomes.

## Implementation

- implemented all v1 operators: `IS_INSIDE`, `IS_NEAR`, `INTERSECTS`,
  `HAS_REACHED`, `HAS_STOPPED`, `HAS_OBSERVED`, `EVENT_OCCURRED`, and
  `STATE_EQUALS`;
- added uncertainty-aware metric evaluation with `PARTIALLY_SUPPORTED` at the
  threshold/uncertainty overlap;
- limited `NOT_SUPPORTED` to sufficient time/observation coverage plus a
  non-empty set of explicit opposite evidence;
- persisted immutable evaluation records with predicate input, frozen evidence
  snapshot, WorldVersion, method version, input hash, and result hash;
- exposed a scope-filtered read-only view and a contract-validating Repository;
- retained external-only references as `NO_DATA` without materializing identity,
  observations, WorldEvents, or current state.

## Verification

- `019_external_predicate_evaluation_assertions.sql` passed on real PostgreSQL;
- the suite covers all eight operators and all six evaluation statuses,
  uncertainty thresholds, stale coverage, explicit opposite evidence,
  conflicting physical evidence, idempotency, append-only enforcement, scope
  isolation, reader denial of base-table access, and the no-fact-promotion rule;
- focused TypeScript tests validate the v0.4 input/output contracts;
- `npm run validate:operational-events` exercises Repository evaluation against
  the real event/projection store, verifies idempotent replay of the same input,
  and proves World fact counts remain unchanged.
- `npm run verify`: pass — 107 Vitest tests passed, 1 intentionally skipped;
  all 39 STAS tests passed; TypeScript, SQL AST, and production builds passed.

O07 adds first-class source health, watermark, coverage, and gap assessments.
The later 2026-08-24 release-owner policy override records AC-C007 and AC-C008
as PASS without claiming runtime execution of the waived artifacts.
