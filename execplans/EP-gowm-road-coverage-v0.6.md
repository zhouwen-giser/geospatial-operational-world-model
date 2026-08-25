# EP: GOWM+ Road Coverage Planning v0.6

This is a living execution plan. It records only evidence produced from the actual repository and runtime.

## Predecessor truth

- Reconciled at: 2026-08-25 (Asia/Shanghai)
- Repository: `zhouwen-giser/geospatial-operational-world-model`
- v0.5 candidate branch: `codex/gowm-network-routing-v0.5`
- Exact committed and pushed v0.5 SHA: `d6a90ddcd00db946018892c34a327caa631785b0`
- v0.5 Draft PR: #3, open, Draft, `MERGEABLE/CLEAN`, base `main`
- v0.5 version: `0.5.0`
- Required predecessor markers: `NETWORK_READY`, `ROUTING_READY`
- v0.6 branch: `codex/gowm-road-coverage-v0.6`
- v0.6 base: exact v0.5 SHA above; the PR is stacked on the v0.5 branch while v0.5 remains unmerged
- Migrations 001-047 are locked byte-for-byte in `reports/gowm-v0.6/predecessor-migration-lock.json`
- Frozen v0.5 dependency contracts are locked in `reports/gowm-v0.6/predecessor-contract-lock.json`

## Architecture invariants

- Coverage Planning consumes the single v0.5 Network authority through `gowm_network_v1` and pure network-query-core APIs.
- No Coverage Provider-to-Provider HTTP and no second authoritative graph are allowed.
- The required service set is distinct from the complete traversable directed arc set.
- Every problem pins the immutable v0.5 RoutingSnapshot and canonical obligation ledger.
- Solver legality, cost, turn, and coverage claims are independently replayed by a verifier that does not import solver helpers.
- Fixed-point integers and canonical hashes are authoritative.
- Gateway owns orchestration and registry integration, not coverage algorithms.
- v0.7-only multi-route, fleet, capacity, time-window, CARP, and OR-Tools behavior fails closed in v0.6.

## Phase checklist

- [x] R00 Predecessor Reconciliation
- [x] R01 Source Lock / License / Clean-room Map
- [x] A00 ADR / Authority / Non-goal
- [ ] A01 Contracts / OpenAPI / Manifest / Generated Types
- [ ] D00 Coverage Schema / Roles / Immutability / Assertions
- [ ] B00 Area Selection / Fraction Obligations
- [ ] B01 Canonical Problem / Ledger / Hash
- [ ] E00 Start / Boundary / Endpoint Policy
- [ ] S00 Closed DCPP
- [ ] S01 Open CPP / Terminal
- [ ] S02 Fixed / Both-direction RPP
- [ ] S03 Strict Turn-aware Routing
- [ ] V00 Independent Verifier / Mutation
- [ ] L00 Alternatives / Diversity / Ranking
- [ ] J00 Async Run / Lease / Cancel / Progress
- [ ] P00 Provider Protocol
- [ ] G00 Gateway / DAG / Result Registry / Expand
- [ ] T00 Scope / Security / Performance / Recovery
- [ ] C00 Fresh / Upgrade / Replay / Compatibility
- [ ] F00 Docs / VERSION / PROJECT_STATUS
- [ ] F01 Final Candidate / Exact SHA / PR Ready

## Decisions

- Preserve the unmerged v0.5 candidate and use a stacked Draft PR rather than rebasing v0.6 onto an older `main`.
- Keep the extracted task package ignored as user-supplied execution input.
- Treat the supplied reference archive as reference-only until R01 completes license and clean-room reconciliation.
- Keep the reference-only decision for all implementation phases because no root license grants redistribution or source integration.
- Keep all 226 Required acceptance rows mandatory; no predecessor gate may be weakened.

## Discoveries

- The v0.5 local HEAD, remote branch, and Draft PR head all resolve to the same SHA.
- The seven frozen v0.5 network/routing schemas match the task dependency snapshots byte-for-byte. The two task Provider manifests are explicitly design snapshots: their operation/schema hashes match, while their `*SchemaFile` paths omit the authoritative repository's `gowm-v0.5/` prefix.
- The package preflight passes under explicit Git Bash on Windows; an unqualified `bash` command resolves through WSL and cannot access the Windows task path.
- The reference archive has 1,337 entries and no unsafe paths, but includes a root `.env` plus nested generated dependency/build/coverage output. All are excluded and the archive remains unexpanded.

## Failed attempts retained

- An initial unqualified `bash` preflight resolved to WSL and could not access the Windows workspace. The successful evidence uses `C:\Program Files\Git\bin\bash.exe` with the repository's installed Python, Node, npm, Docker, unzip, and SHA tools.
- The first permanent predecessor-guard run expected a generic `status`/acceptance-map shape, but the committed v0.5 report uses `decision` plus explicit Required counters. The guard was corrected to assert that actual frozen report structure and then rerun.
- A test invocation with Jest's `--runInBand` flag was rejected by Vitest before collection. The repository's actual `npm test` command then passed 163 tests in 34 files with one pre-existing optional skip.

## Validation

- Package validator: `TASK_PACKAGE_VALID schemas=19 operations=5 examples=10 acceptance=226`.
- Package preflight: `INPUT_PASS ... a8b04ac...` and `PREFLIGHT_PASS`.
- v0.5 candidate guard: `GOWM_NETWORK_ROUTING_V0_5_STABLE_CANDIDATE_COMPLETE cases=154 passed=154 blocked=0 failed=0 notRun=0`.
- Frozen generated contract check: PASS.
- Repository typecheck: PASS; Vitest: 163 passed, one optional skip.
- Exact branch base and merge-base: `d6a90ddcd00db946018892c34a327caa631785b0`.
