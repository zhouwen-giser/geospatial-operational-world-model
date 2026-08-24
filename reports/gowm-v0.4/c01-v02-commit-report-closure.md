# C01 v0.2 Commit and Report Closure

## Decision

`PASS`

The v0.2 implementation is covered by committed and pushed SHA
`1887e56a18b77aa9692cca9d86b00413906816f4`. C00 reconciliation was committed
and pushed at `80f10718fc2cdeeb9c915bdb49c499d1930eb9a3`.

The stale Git-delivery statements in `PROJECT_STATUS.md`, the P17 completion
report, the P17 acceptance record, and the final candidate report were
corrected without deleting the historical reports. The live-runtime decision
remains blocked and was not promoted.

## Necessary closure fixes

- Corrected the H3 Toolkit bridge dependency from the nonexistent
  `@gowm/contract-runtime` package to the committed
  `@gowm/platform-contract-runtime` workspace and refreshed the lock file.
- Wired the Provider SDK's injected clock into deadline enforcement so
  deterministic conformance tests and runtime deadline checks use one clock.
- Made the two expired-deadline fixtures relative to their injected clocks.

The first `npm run verify` failed before tests because dependencies were absent.
The first `npm ci` then exposed the incorrect workspace package name. After the
fix, `npm ci` completed with zero audit vulnerabilities. A sandboxed verify run
also retained an expected `listen EPERM` for a loopback MCP fixture; the final
run outside that network sandbox passed.

## Verification

| Command | Result |
|---|---|
| `npm ci` | PASS; 264 packages, 0 vulnerabilities |
| targeted compatibility and Geometry tests | PASS; 23/23 |
| `npm run verify` | PASS; root 79 passed/1 skipped, STAS 39 passed, build PASS |

## Acceptance

- AC-C003: PASS — v0.2 implementation is committed and pushed.
- AC-C004: PASS — current status and P17 now reflect actual Git state.
- AC-C012: PASS — PR #1 remains Draft and user-controlled.

## Remaining boundary

C02 must still run or accurately block the real PostgreSQL, locked Provider,
exact DAG, scope, restart, and idempotency matrix. No merge, tag, release, or
deployment was performed.
