# Phase Completion Report

## Phase
C05 — Result Correctness

## Scope completed
Truthful NO_FEASIBLE_RESULT/FAILED separation, distinct problem/data/compute hashes, traversal-credit semantics, immutable registry publication, and scoped GeoJSON expansion.

## Source state
Candidate based on locked R00 source.

## Migrations/contracts
Migration 056 and SQL assertion 041; additive result schemas.

## Tests actually run
| command | result | evidence |
|---|---|---|
| `npm run verify:sql` | PASS | 57 migrations / 42 assertions |
| `npm test` | PASS | 257 passed, 1 skipped |

## Acceptance cases
AC-C05-01–AC-C05-18; durable/restart publication proof passed in C06/S01.

## Authority/scope/compatibility review
GeoJSON reads immutable artifacts and versioned network reads, not public base tables.

## Failed attempts
None retained for this phase.

## Commit/push/PR
`edea8bc fix(coverage): publish truthful result evidence`; pushed to Draft PR #6.

## Blockers
None; D00, G00, T00 and C00 runtime gates all PASS.

## Next phase
C06.

## Final runtime reconciliation (2026-08-26)

D00 PASS (57 migrations / 42 assertion suites; fresh and v0.4/v0.5/v0.6.0 upgrades),
G00 PASS (150 checks), T00 PASS (72 before / 5 after real PostgreSQL restart),
and C00 compatibility PASS. See the phase acceptance JSON and
`validation/gowm-v0.6.1/case-evidence.json` for this phase's named checks.
Full regression: 264 Vitest tests passed; the single default database-test skip
is replaced by the real Docker gates. STAS: 14 files passed; conformance: 9/9.

Compute manifests now contain the solver/verifier/network-core versions,
actual build digest, policies, and contract hashes. Data/compute/problem hashes
remain independent. Legacy records without a compute receipt get an explicit
UNKNOWN manifest, never a reconstructed or invented original compute identity.
