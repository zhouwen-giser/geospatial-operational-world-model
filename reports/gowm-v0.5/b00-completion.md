# B00 Baseline Reconciliation Completion

## Scope completed

Fetched the actual `origin/main`, confirmed the compatible v0.4 baseline, created the candidate branch, preserved the initially clean worktree, and recorded immutable SHA-256 hashes for migrations 001-032.

## Source state

- Base/local/remote before implementation: `db575f79c874a69f65a2043a7e463338524b713d`
- Version: `0.4.0`
- Branch: `codex/gowm-network-routing-v0.5`
- PR #2 merge evidence: the baseline commit is `Merge pull request #2 ...`
- Worktree was clean before the requested task package was extracted.

## Migrations/contracts

Migrations 001-032 were not modified. Their actual baseline hashes are recorded in `baseline-migration-lock.json`.

## Tests actually run

| command | result | evidence |
|---|---|---|
| `git fetch origin main` | PASS | `origin/main` resolved to `db575f7` |
| `git rev-parse HEAD` / `origin/main` | PASS | both exact full SHAs matched |
| `Get-FileHash database/migrations/001..032` | PASS | 32 SHA-256 values recorded |
| task-package validator | PASS | 19 schemas, 2 providers, 8 examples, 155 acceptance rows |
| initial `npm.cmd run verify` | FAIL | Windows `core.autocrlf=true` changed checked-out JSON line endings before raw-byte hashing; SQL AST and 116 tests passed, one contract hash assertion failed |
| cross-platform canonical-byte regression | FIXED | contract test hashes LF canonical repository bytes while preserving the exact locked digest |
| rerun `npm.cmd run verify` | PASS | 32 migration AST checks, 117 Vitest tests, 39 STAS tests, typecheck and build passed; one pre-existing Vitest case remained explicitly skipped |

## Acceptance cases

`AC-B001`, `AC-B002`, and `AC-B003` pass based on the evidence above.

## Network authority/scope review

No network runtime or authority was added in this phase.

## Source reuse and license review

No reference source was expanded or copied into the implementation.

## Failed attempts

The first full baseline verification failed on a v0.4 manifest hash assertion because Git for Windows materialized the locked LF JSON blob as CRLF. The test now normalizes only line endings before comparing the same exact locked digest; contract content and manifests were not changed. A full rerun is required.

## Commit/push/PR

Recorded after the phase commit in Git/PR state; no merge, tag, release, or deployment is authorized.

## Blockers

None for B00.

## Next phase

B01 Source Lock.
