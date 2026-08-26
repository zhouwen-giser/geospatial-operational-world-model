# Phase Completion Report

## Phase
C02 — Boundary Authority

## Scope completed
Directed, fraction-aware Polygon/MultiPolygon crossing and membership reads; authoritative verification ignores candidate hints and fails closed.

## Source state
Candidate based on locked R00 source.

## Migrations/contracts
Migration 055 and SQL assertion 040.

## Tests actually run
| command | result | evidence |
|---|---|---|
| `npm run verify:sql` | PASS | SQL AST |
| `npm test` | PASS | boundary golden/unit suites |

## Acceptance cases
AC-C02-01–AC-C02-24; real PostGIS replay passed in C06/G00.

## Authority/scope/compatibility review
Crossings come from scoped `gowm_network_v1`; invalid geometry and overlap fail closed.

## Failed attempts
The first real pass exposed typed-empty PostGIS and provider-role defects; both were corrected in the versioned read contract.

## Commit/push/PR
`83cc0a1 fix(coverage): verify authoritative boundary crossings`; pushed to Draft PR #6.

## Blockers
None; final real G00 has 150 passing checks.

## Next phase
C03.

## Final runtime reconciliation (2026-08-26)

D00 PASS (57 migrations / 42 assertion suites; fresh and v0.4/v0.5/v0.6.0 upgrades),
G00 PASS (150 checks), T00 PASS (72 before / 5 after real PostgreSQL restart),
and C00 compatibility PASS. See the phase acceptance JSON and
`validation/gowm-v0.6.1/case-evidence.json` for this phase's named checks.
Full regression: 264 Vitest tests passed; the single default database-test skip
is replaced by the real Docker gates. STAS: 14 files passed; conformance: 9/9.

The eleven boundary-policy runtime cases independently assert boundary validity
using directed segments read from real PostGIS. Full route validity and
Gateway publication are checked separately by the main plan/verify E2E; a
boundary predicate pass is not claimed to prove all other plan invariants.
