# B00 Source Reconciliation

## Result

`PASS`

## Source state

- Package baseline: `537fd7ec9e73fa7ab945d1ebec7dd3a6913aa9ee`.
- Fetched `origin/main`: `537fd7ec9e73fa7ab945d1ebec7dd3a6913aa9ee`.
- Baseline version: `0.6.2`.
- Forward drift: none.
- Worktree: `/tmp/gowm-grounding-core-stabilization-v0.6.3`.
- Branch: `codex/gowm-grounding-core-stabilization-v0.6.3`.

The pre-existing untracked task package in the primary checkout was neither
reset, stashed nor modified after extraction. All implementation work is in the
isolated worktree.

## Tests actually run

| command | result | evidence |
|---|---|---|
| `npm ci` | PASS | lockfile install, 0 vulnerabilities |
| `npm run verify` | PASS | contracts/types/SQL, 326 Vitest, 40 STAS tests, build |
| `npm run validate:world-platform-regression` | PASS | 13/13 commands in `reports/gowm-v0.6.2/regression/report.json` |

One existing optional external-database Vitest case remains skipped. Dedicated
real PostgreSQL gates are required again in S00 and are not inferred from the
baseline unit suite.

## Acceptance

`AC-B001` through `AC-B008`: PASS. The architecture boundary assertions are
covered by the existing regression suite and source comparison. No upper-layer
runtime dependency, provider-to-provider call, foundation write coupling or
algorithm change has been introduced.

## Failed attempts retained

The first sandboxed `npm ci` failed because execution of the installed esbuild
binary was denied with `EPERM`. Re-running the identical lockfile install in the
approved execution environment succeeded.
