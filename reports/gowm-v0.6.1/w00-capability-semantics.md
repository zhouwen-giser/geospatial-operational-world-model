# Phase Completion Report

## Phase
W00 — Capability Semantic Projection

## Scope completed
Deterministic Gateway projection of approved registry descriptors with typed reference/relation/result/currentness semantics and detail endpoint.

## Source state
Candidate based on locked R00 source.

## Migrations/contracts
Additive semantic profile/catalog schemas and Gateway routes.

## Tests actually run
| command | result | evidence |
|---|---|---|
| `npm test` | PASS | semantic contract and Fastify HTTP tests |
| provider conformance gate | PASS | 9 providers; aggregate report |

## Acceptance cases
AC-W00-01–AC-W00-22.

## Authority/scope/compatibility review
The projection has no writable second registry.

## Failed attempts
None retained for this phase.

## Commit/push/PR
`f3d3c91 feat(gateway): project capability semantics`; pushed to Draft PR #6.

## Blockers
None; final real G00 has 150 passing checks.

## Next phase
W01.

## Final runtime reconciliation (2026-08-26)

D00 PASS (57 migrations / 42 assertion suites; fresh and v0.4/v0.5/v0.6.0 upgrades),
G00 PASS (150 checks), T00 PASS (72 before / 5 after real PostgreSQL restart),
and C00 compatibility PASS. See the phase acceptance JSON and
`validation/gowm-v0.6.1/case-evidence.json` for this phase's named checks.
Full regression: 264 Vitest tests passed; the single default database-test skip
is replaced by the real Docker gates. STAS: 14 files passed; conformance: 9/9.
