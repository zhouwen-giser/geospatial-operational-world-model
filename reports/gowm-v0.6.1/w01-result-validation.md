# Phase Completion Report

## Phase
W01 — Normalized Result Semantics

## Scope completed
Complete known status mapping, original source status retention, scoped batch validation, retired/stale/expired handling, and evidence references.

## Source state
Candidate based on locked R00 source.

## Migrations/contracts
Migration 057 read authority and additive validation schemas.

## Tests actually run
| command | result | evidence |
|---|---|---|
| `npm test` | PASS | result-validation unit/provider suites |
| `npm run check` | PASS | schema/type parity |

## Acceptance cases
AC-W01-01–AC-W01-18.

## Authority/scope/compatibility review
Existing Result/Reference authorities remain canonical; validation is read-only.

## Failed attempts
Audit found normalized registry status had replaced the original provider status; PostgreSQL authority now retains both.

## Commit/push/PR
`60fe876 feat(validation): add authoritative result checks`; final PostgreSQL status correction is in the current candidate change set.

## Blockers
None; final real G00 has 150 passing checks.

## Next phase
W02.

## Final runtime reconciliation (2026-08-26)

D00 PASS (57 migrations / 42 assertion suites; fresh and v0.4/v0.5/v0.6.0 upgrades),
G00 PASS (150 checks), T00 PASS (72 before / 5 after real PostgreSQL restart),
and C00 compatibility PASS. See the phase acceptance JSON and
`validation/gowm-v0.6.1/case-evidence.json` for this phase's named checks.
Full regression: 264 Vitest tests passed; the single default database-test skip
is replaced by the real Docker gates. STAS: 14 files passed; conformance: 9/9.
