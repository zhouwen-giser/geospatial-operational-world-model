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
- [x] A01 Contracts / OpenAPI / Manifest / Generated Types
- [x] D00 Coverage Schema / Roles / Immutability / Assertions
- [x] B00 Area Selection / Fraction Obligations
- [x] B01 Canonical Problem / Ledger / Hash
- [x] E00 Start / Boundary / Endpoint Policy
- [x] S00 Closed DCPP
- [x] S01 Open CPP / Terminal
- [x] S02 Fixed / Both-direction RPP
- [x] S03 Strict Turn-aware Routing
- [x] V00 Independent Verifier / Mutation
- [x] L00 Alternatives / Diversity / Ranking
- [x] J00 Async Run / Lease / Cancel / Progress
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
- A01's first wildcard copy used PowerShell `-LiteralPath`, which correctly treated the wildcard literally and copied no schemas/examples. The mechanical copy was rerun with `-Path`; all 19 schemas and 10 examples were then counted and hashed.
- A01's first full typecheck exposed an imprecise last-position narrowing in new Polygon semantics. Explicit first/last locals fixed the type without weakening validation.
- D00's first real runtime script issued one Docker `exec` per migration registration and was stopped after proving the approach would spend most of its time in Windows Docker startup overhead. The exact temporary fresh database was confirmed and removed, then migration/assertion input was safely batched.
- D00's first completed batch run exposed a test-only reference to the nonexistent `network_foundation` schema. The authority tables are actually in `public`; all three permission probes were corrected without changing grants.
- D00's next run passed both full database paths but the final summary expected eight private functions. The actual schema intentionally has two trigger functions plus seven controlled APIs; the gate now proves nine total and exactly seven Provider-executable functions.
- B00's first real application-container run found that the new runtime client was not in the root TypeScript compile allowlist; the client was added explicitly and the isolated database was cleaned.
- B00's next run proved the Coverage role correctly lacked `public` schema/PostGIS access. Migration 050 therefore adds one narrow `gowm_network_v1` security-definer read function instead of granting broad public or base-table rights.
- B00's first controlled-function run returned the correct four symmetric-hole obligations, while the test incorrectly expected four distinct numeric fraction intervals. The assertion now keys by Arc plus fractions, proving two fragments on each of two directions.
- The first 050 database regression passed all migrations/assertions but retained a historical summary expectation of 49 migrations. The current gate now asserts 50 migrations and 35 assertions.
- B01's first snapshot-sensitivity test replaced the problem snapshot but intentionally left obligations hashed against the old snapshot, so the tamper guard rejected it before hashing. The legal variant now regenerates its obligation identities against the new snapshot and proves a changed problem hash.
- J00's first 051 database regression correctly rejected a progress timeline that moved from 500000 ppm to 0 on lease requeue. The reaper now inherits the prior generation's maximum progress; the failed evidence is retained and the fresh/upgrade rerun passed.

## Validation

- Package validator: `TASK_PACKAGE_VALID schemas=19 operations=5 examples=10 acceptance=226`.
- Package preflight: `INPUT_PASS ... a8b04ac...` and `PREFLIGHT_PASS`.
- v0.5 candidate guard: `GOWM_NETWORK_ROUTING_V0_5_STABLE_CANDIDATE_COMPLETE cases=154 passed=154 blocked=0 failed=0 notRun=0`.
- Frozen generated contract check: PASS.
- Repository typecheck: PASS; Vitest: 163 passed, one optional skip.
- Exact branch base and merge-base: `d6a90ddcd00db946018892c34a327caa631785b0`.
- D00 static SQL AST: 49 migrations and 34 assertion files PASS; boundary guard PASS.
- D00 real PostgreSQL gate: `GOWM_COVERAGE_SCHEMA_RUNTIME_PASS d00-20260825t0850 migrations=49 assertions=34`; fresh and v0.5-upgrade paths PASS, both deliberate failure probes rolled back, and both isolated databases were removed.
- B00 real PostGIS gate: `GOWM_COVERAGE_SELECTION_RUNTIME_PASS b00-20260825t0930 checks=14`; Polygon holes, MultiPolygon ordering, covers/intersects/clips, road/service filters, one-way/both-direction expansion, manual validation, scope-first denial, budgets, and empty selection PASS.
- Post-B00 database regression: `GOWM_COVERAGE_SCHEMA_RUNTIME_PASS b00-db-20260825t0950 migrations=50 assertions=35`; fresh/upgrade/rollback paths PASS and isolated databases were removed.
- B01 canonical gate: `GOWM_COVERAGE_CANONICAL_PROBLEM_PASS b01-20260825t1010 combinations=36`; all 6 obligation-order × 6 endpoint-candidate-order combinations produced one contract-valid obligation-set hash and one problem hash.
- E00 real endpoint gate: `GOWM_COVERAGE_ENDPOINT_RUNTIME_PASS e00-20260825t1020 checks=13`; parallel-road ambiguity, directed partial state, AUTO boundaries, ReferenceKey resolution, fixed entry/end, last exit, crossing policies, scope-first denial, and unknown-state rejection PASS.
- S00 exact solver gate: `GOWM_COVERAGE_CLOSED_DCPP_PASS s00-20260825t1055 checks=6 segments=9`; balanced Euler coverage, exact minimum-cost directed augmentation, deterministic replay, contract-valid output, and exact 345678 ppm terminal closure PASS.
- S01 exact solver gate: `GOWM_COVERAGE_OPEN_DCPP_PASS s01-20260825t1105 checks=7 segments=5`; distinct exact fixed terminal, requested open degree vector, partial ACCESS/RETURN continuity, deterministic replay, and contract-valid output PASS.
- S02 RPP gate: `GOWM_COVERAGE_FIXED_RPP_PASS s02-20260825t1120 checks=11 scenarios=3`; required-subset/full-network separation, disconnected component connection, exact partial service, repeated and both-direction obligations, duplicate/transit roles, deterministic replay, and frozen contracts PASS.
- S03 strict solver gate: `GOWM_COVERAGE_STRICT_ROUTING_PASS s03-20260825t1140 checks=23 objectives=3`; pairwise/allowed-only/multi-edge rules, cross-boundary history, no primitive downgrade, conditions/profiles, safe fixed metrics, three distinct objectives, replay/version fencing, resource budgets, and Stable negative guards PASS.
- V00 independent verifier gate: `GOWM_COVERAGE_INDEPENDENT_VERIFIER_PASS v00-20260825t1210 checks=22 mutations=12`; isolated imports, independent topology/turn/coverage/endpoint/boundary/profile/condition/metric/hash replay, mutation corpus, admission boundary, and frozen receipt contract PASS. Real-e2e stale row `AC-V018` remains deferred.
- L00 alternatives gate: `GOWM_COVERAGE_ALTERNATIVES_PASS l00-20260825t1235 checks=13 selected=2`; verified-only admission, signature/display dedup, weighted overlap, deadhead Jaccard, deterministic ranking, truthful facts, deep freeze, explicit termination, and frozen result contract PASS. Real E2E and DB rows remain deferred.
- J00 database regression: `GOWM_COVERAGE_SCHEMA_RUNTIME_PASS j00-db-20260825t1305 migrations=51 assertions=36`; fresh and exact-v0.5 upgrade paths, controlled-function grants, failure rollback, lease/reaper/generation assertions, and isolated database cleanup PASS.
- J00 real async runtime gate: `GOWM_COVERAGE_ASYNC_RUNTIME_PASS j00-20260825t1110 checks=15`; replay/conflict, ordered SKIP LOCKED claim, per-scope admission, bounded heartbeat, monotonic progress, Gateway connection-pool restarts, lease reaping, generation retry, cancel/late-result fencing, completed-result replay, and simultaneous cancel/publish terminal coherence PASS.
- Post-J00 selection regression: `GOWM_COVERAGE_SELECTION_RUNTIME_PASS j00-b00-20260825t1055 checks=14`; migration 051 preserves all B00 PostGIS selection behavior.
