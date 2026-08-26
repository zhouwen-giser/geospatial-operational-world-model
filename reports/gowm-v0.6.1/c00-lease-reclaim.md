# Phase Completion Report

## Phase
C00 — Lease Reclaim

## Scope completed
Database-owned attempt/generation allocation, expiry/requeue/reclaim, and stale-worker fencing for heartbeat, problem, candidate, and publication.

## Source state
Candidate based on locked R00 source.

## Migrations/contracts
Migration 054 and SQL assertion 039.

## Tests actually run
| command | result | evidence |
|---|---|---|
| `npm run verify:sql` | PASS | 57 migrations / 42 assertion suites |
| `npm test` | PASS | 257 passed, 1 skipped |

## Acceptance cases
AC-C00-01–AC-C00-14; final real restart/reclaim proof is owned by S01/T00.

## Authority/scope/compatibility review
Only PostgreSQL assigns monotonic generations; callers cannot unfence stale work.

## Failed attempts
None retained for this phase.

## Commit/push/PR
`4f4aba1 fix(coverage): make lease reclaim generation-safe`; pushed to Draft PR #6.

## Blockers
None for implementation; final T00 evidence remains a stable-candidate gate.

## Next phase
C01.

## Final runtime reconciliation (2026-08-26)

D00 PASS (57 migrations / 42 assertion suites; fresh and v0.4/v0.5/v0.6.0 upgrades),
G00 PASS (150 checks), T00 PASS (72 before / 5 after real PostgreSQL restart),
and C00 compatibility PASS. See the phase acceptance JSON and
`validation/gowm-v0.6.1/case-evidence.json` for this phase's named checks.
Full regression: 264 Vitest tests passed; the single default database-test skip
is replaced by the real Docker gates. STAS: 14 files passed; conformance: 9/9.
