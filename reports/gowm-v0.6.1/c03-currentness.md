# Phase Completion Report

## Phase
C03 — Currentness

## Scope completed
Frozen validity, graph/travel/cost/condition/source-world currentness, and TTL are separate; Route and Coverage Verify share the evaluator.

## Source state
Candidate based on locked R00 source.

## Migrations/contracts
v0.6.1 routing-currentness and plan-validation schemas; migration 055 exposes deterministic profile ordering data.

## Tests actually run
| command | result | evidence |
|---|---|---|
| `npm test` | PASS | 257 passed, 1 skipped |
| `npm run check` | PASS | type/contract generation |

## Acceptance cases
AC-C03-01–AC-C03-16; real condition/profile changes passed in C06/G00.

## Authority/scope/compatibility review
Validation never replans or mutates a frozen result.

## Failed attempts
Matrix audit found Coverage Verify was comparing the pinned snapshot to itself; it now calls the shared currentness authority.

## Commit/push/PR
`74be8c6 feat(routing): separate validity from currentness`; final Coverage integration is in the current candidate change set.

## Blockers
None; final real G00 has 150 passing checks.

## Next phase
C04.

## Final runtime reconciliation (2026-08-26)

D00 PASS (57 migrations / 42 assertion suites; fresh and v0.4/v0.5/v0.6.0 upgrades),
G00 PASS (150 checks), T00 PASS (72 before / 5 after real PostgreSQL restart),
and C00 compatibility PASS. See the phase acceptance JSON and
`validation/gowm-v0.6.1/case-evidence.json` for this phase's named checks.
Full regression: 264 Vitest tests passed; the single default database-test skip
is replaced by the real Docker gates. STAS: 14 files passed; conformance: 9/9.
