# A00 Architecture Authority and Non-goals Completion

## Phase / Scope

A00 accepts ADR 006, freezes the runtime/ownership matrix, and adds an executable source/SQL boundary guard. Contract-shape gates remain truthfully deferred to A01.

## Source state

- Branch: `codex/gowm-road-coverage-v0.6`
- Prior pushed SHA and Draft PR head: `079b081f53ca38bc67084406eb210cbbdc289283`
- PR #4: open Draft, stacked on v0.5, `MERGEABLE/CLEAN`

## Contracts / migrations

No contract or migration is changed in A00. ADR 006 prohibits Coverage-owned graph/arc/turn authority tables and limits future Coverage persistence to derived, pinned, append-only artifacts.

## Tests actually run

| command | result | evidence |
|---|---|---|
| `npm.cmd run validate:gowm-v06-boundaries` | PASS | authority markers, Gateway, Provider, Verifier, and SQL boundaries |
| `npm.cmd run validate:gowm-v06-source-policy` | PASS | clean-room and mandatory v0.5 reuse markers |
| `npm.cmd run validate:gowm-v06-predecessor` | PASS | 47 migrations and 9 contracts remain locked |
| `npm.cmd run check` | PASS | repository and STAS typecheck |
| `npm.cmd test` | PASS | 163 regression tests passed; one pre-existing optional skip |

## Acceptance IDs

`AC-A001..AC-A004`, `AC-A007`, `AC-A010`, and `AC-A012` pass. Contract-shape rows `AC-A005`, `AC-A006`, `AC-A008`, `AC-A009`, and `AC-A011` remain `NOT_RUN_A01`, not inferred from prose.

## Authority / scope review

The one v0.5 Network authority, R/E separation, independent verifier, generic Gateway, single-route stable scope, and computational-result non-claim are frozen. Unsupported v0.7 fields must produce typed errors rather than best-effort behavior.

## Failed attempts

None in A00.

## Commit / push / PR

A00 is delivered as a semantic phase commit and pushed to Draft PR #4.

## Blockers / Next

No A00 blocker. Proceed to A01 authoritative JSON Schemas, OpenAPI, Provider manifest, generated runtime types, negative validation, and schema hash locks.
