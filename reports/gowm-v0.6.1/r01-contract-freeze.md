# Phase Completion Report

## Phase
R01 — ADR / Contract Freeze

## Scope completed
Source lock, additive v0.6.1 schemas/OpenAPI, compatibility policy, and ADR-0061 are frozen.

## Source state
`main@7cd5b133a74b07e28f359176dd13943ab7a6cf54`; candidate branch `codex/gowm-platform-hardening-v0.6.1`.

## Migrations/contracts
Existing migrations 001–053 remain unchanged; repository and task-package schemas validate.

## Tests actually run
| command | result | evidence |
|---|---|---|
| task-package validator | PASS (21 schemas, 10 profiles, 10 examples, 229 cases) | package validator output |
| `npm run check` | PASS | local candidate run |

## Acceptance cases
AC-R003, AC-R011, AC-R012.

## Authority/scope/compatibility review
Additive public contracts; no second registry/catalog authority.

## Failed attempts
System jsonschema was too old; isolated jsonschema 4.25.1 validation passed.

## Commit/push/PR
`a7d5018 docs(v0.6.1): freeze correctness and public contract ADRs`; pushed to Draft PR #6.

## Blockers
None for R01.

## Next phase
C00.

## Final runtime reconciliation (2026-08-26)

D00 PASS (57 migrations / 42 assertion suites; fresh and v0.4/v0.5/v0.6.0 upgrades),
G00 PASS (150 checks), T00 PASS (72 before / 5 after real PostgreSQL restart),
and C00 compatibility PASS. See the phase acceptance JSON and
`validation/gowm-v0.6.1/case-evidence.json` for this phase's named checks.
Full regression: 264 Vitest tests passed; the single default database-test skip
is replaced by the real Docker gates. STAS: 14 files passed; conformance: 9/9.
