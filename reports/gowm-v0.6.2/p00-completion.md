# P00 — Source reconciliation

Actual fetched main: `55ebd33ce1f75537fa7a95c9f0dc538bf6d430c1`, VERSION 0.6.1; matches package baseline.
The original worktree remains at 7cd5b13 with its untracked v0.6.1 task package untouched.
Independent branch/worktree: `codex/gowm-world-platform-gateway-semantics-v0.6.2`, `/tmp/gowm-world-platform-gateway-semantics-v0.6.2`.

## Actual checks
- Package preflight and validator PASS: 11 schemas, 14 rules, 13 examples, 180 acceptance rows.
- `npm run verify` PASS: 288 tests, one existing external database test skipped; STAS 40 tests; contract generation, TypeScript, SQL AST and build.
- Predecessor byte lock PASS: 53 migrations / 103 historical contracts unchanged.
- Architecture boundaries PASS.
- Provider conformance PASS: 11 reports / 70 protocol operations; this is contract/unit evidence, not live readiness.
- Initial sandbox failures (listen/spawnSync EPERM) retained; reruns with authorization passed.

## Reconciliation
21 manifest files include current aliases. 15 provider identities are required/optional in the requested platform; STAS is native-only and needs an execution-protocol adapter. Network, Route and Coverage need canonical manifests and a controlled registry fragment. Existing two fragments cover 11 identities. All existing maturities are preserved until operation-specific evidence requires a recorded change.
No GOWM database container or complete database image exists on the host. A dedicated image build is in progress. Real PostgreSQL/Provider/Gateway gates remain pending; old runtime reports are historical evidence only.

No merge, tag, release, deployment, core fact/algorithm modification or upper-layer repository modification performed.

Next: P01 explicit contract freeze; real runtime validation will be freshly executed.
