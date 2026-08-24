# R00 Predecessor Reconciliation Completion

## Phase / Scope

R00 reconciles the actual committed and pushed v0.5 candidate, its Draft PR, stable markers, migration bytes, frozen contracts, Provider/Gateway evidence, and the exact v0.6 branch base. It does not claim the R01 source-license gate.

## Source state

- v0.5 local, remote, and Draft PR head: `d6a90ddcd00db946018892c34a327caa631785b0`
- v0.5 Draft PR #3: open, Draft, `MERGEABLE/CLEAN`, base `main`
- v0.6 branch initial HEAD and merge-base: the exact v0.5 SHA above
- Existing worktree was clean before task-package extraction. The extracted package is preserved and ignored, not committed.

## Contracts / migrations

- `VERSION` is exactly `0.5.0` at the branch point.
- `NETWORK_READY` and `ROUTING_READY` are present in committed machine evidence.
- Migrations 001-047 are recorded by filename and SHA-256 without modification.
- The seven v0.5 network/routing schema snapshots match the authoritative files byte-for-byte. The two Provider snapshots preserve the same operation and schema hashes but omit the authoritative manifests' `gowm-v0.5/` path prefix; the task lock labels these as design snapshots, so runtime consumption remains pinned to the actual repository manifests.

## Tests actually run

| command | result | evidence |
|---|---|---|
| task package Python validator | PASS | `schemas=19 operations=5 examples=10 acceptance=226` |
| explicit Git Bash `scripts/preflight.sh` | PASS | reference archive SHA-256 matched and `PREFLIGHT_PASS` |
| `scripts/check-v05-predecessor.sh` | PASS | `version=0.5.0`, exact predecessor SHA |
| `npm.cmd run validate:gowm-v05-final` | PASS | 154/154 required cases passed; none blocked, failed, or not run |
| `npm.cmd run verify:contracts` | PASS | generated frozen contracts are current |
| `npm.cmd run check` | PASS | contract generation, repository TypeScript, and STAS typecheck |
| `npm.cmd test` | PASS | 163 tests passed in 34 files; one pre-existing optional test/file skipped |
| Git HEAD/merge-base/remote/PR reconciliation | PASS | all predecessor heads resolve to the exact candidate SHA |

## Acceptance IDs

`AC-B001..AC-B008` and `AC-B010..AC-B012` pass. `AC-B009` remains explicitly `NOT_RUN_R01_SOURCE_LOCK_PHASE` until R01 records the reference archive license and clean-room reuse map.

## Authority / scope review

R00 changes no v0.5 migration, contract, Provider, runtime, test, or Required gate. The v0.6 branch is stacked because v0.5 has not been merged into `main`.

## Failed attempts

An unqualified `bash` invocation resolved to WSL and could not access the Windows workspace. The successful preflight used Git Bash explicitly. This environment correction does not alter the test or its input.

The first new permanent guard run also assumed a generic `status` field in the v0.5 final report. The actual committed schema uses `decision` and explicit Required counters, so the guard was corrected to validate the real report shape and rerun.

The first unit-test command supplied Jest's unsupported `--runInBand` option to Vitest and failed before test collection. The unmodified repository test command was then run and passed 163 tests.

## Commit / push / PR

The phase is delivered on `codex/gowm-road-coverage-v0.6`. Push and stacked Draft PR creation follow this report in the same phase workflow; the next phase updates `sync-state.json` with the resulting remote/PR identity.

## Blockers / Next

No R00 blocker. Proceed to R01 Source Lock, License, and Clean-room Map.
