# O08 Append-only Analysis Findings and Replay

## Decision

`PASS`

The O04 correlation resolver remains the single correlation model: exact,
conflicting, inferred, and no-match findings are append-only and replayable.
O08 closes the corresponding PredicateEvaluation replay requirement without
duplicating correlation state or changing OperationalTask identity.

## Implementation

- added immutable PredicateEvaluation replay receipts pinned to the original
  predicate, evidence WorldVersion, method/policy version, observability
  assessment, input hash, and result checksum;
- records the bounded source-event range and a structured difference report;
- added a scope-filtered `analysis_finding` view that presents correlation and
  predicate findings together while preserving their distinct status models;
- added Repository replay with an authorized-scope precheck;
- retained O04 precedence, conflicting-match, no-match, candidate, and replay
  behavior unchanged.

## Verification

- `021_operational_analysis_findings_replay_assertions.sql` passes on real
  PostgreSQL and proves predicate replay `MATCH`, correlation replay `MATCH`,
  frozen hashes/policy/WorldVersion, append-only receipts, cross-scope denial,
  and the unified scoped view;
- the original O04 real-PostgreSQL correlation suite continues to prove
  `CONFLICTING_MATCHES`, `NO_MATCH_FOUND`, candidates, no truth mutation, and
  immutable findings;
- `npm run validate:operational-events` now replays the real predicate result
  after event → projection → correlation → observability → predicate execution.
- `npm run verify`: pass — 114 Vitest tests passed, 1 intentionally skipped;
  all 39 STAS tests passed; TypeScript, SQL AST, and production builds passed.

The locked C02 items AC-C007 and AC-C008 remain `BLOCKED_EXTERNAL`.
