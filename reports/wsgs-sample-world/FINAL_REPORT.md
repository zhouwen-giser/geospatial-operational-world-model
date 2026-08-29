# GOWM+ WSGS Sample World Final Report

## Decision

`PASS — AUTHORIZED LOCAL TEST-INSTANCE AND HANDOFF SCOPE`

All executed local technical gates passed. This is not an unconditional `111/111`
task-package delivery claim: protected Git and PR gates were not authorized and
remain explicitly `NOT_RUN`.

## Candidate

- Version: `0.6.3`
- Branch: `codex/gowm-wsgs-sample-world-test-instance-v0.6.3`
- Base/current HEAD at report audit: `17dd221330d9af540ec815a39eca96550690299a`
- Candidate state: `LOCAL_UNCOMMITTED TEST-INSTANCE CANDIDATE`
- Published/exact PR SHA: `NOT_AVAILABLE`
- Merge-ready claim: `NOT_MADE`
- Original checkout: clean `main` at `17dd221330d9af540ec815a39eca96550690299a`

If a local candidate commit is created later, update this section and rerun the
exact-SHA checks before changing its status.

## Source, realization, and loaded-state identity

| Identity | Value |
|---|---|
| Source fixture hash | `sha256:732172f75e4a7756635a5aefceee909cd2cb79acb8e3b3fd74b70d82095c4025` |
| Generated fixture hash | `sha256:8a1ae55b407db37d086e034f17bac9660f52c15d3f4a850a6020349883c6e942` |
| Realization ID | `sample-realization-b24a5c48-e1f0-5031-90df-29d21d068777` |
| Realization hash | `sha256:b988ff9f163ebb5a4e4cecb167f88f53ad0222820418e9ee753e38238f851e07` |
| Realization T0 | `2026-08-27T13:03:46.516Z` |
| Final loaded-state hash, v1 | `7ccb293a43de508b719011b46d63534fface1962a57f54c4cd6afa0d6f053ce6` |
| Mutation loaded-state hash, v2 | `52c77dcd3a718ac81dcf256698e943f1c0fe9c70f96ceb308eac5e6e9a52b1f0` |

The host-generated realization manifest and the Linux loader report bind to the
same realization and source hashes. Canonical text ordering is locale independent.

## Sample world inventory

- 4 datasets
- 9 spatial features
- 7 world objects
- 7 baseline observations
- 26 reference entries
- 13 task-package expected cases
- Deterministic generation and idempotent load: `PASS`

## Runtime and Gateway qualification

- Final state: `v1`
- Required operation availability: `12/12 AVAILABLE`
- PostgreSQL, five Providers, and the single Gateway: `HEALTHY`
- Host Gateway binding: `127.0.0.1:18063`
- Database marker: `gowm_wsgs_sample/gowm-wsgs-sample-world/1.0`
- Real single-Gateway canary: `28/28 PASS`
- Promoted operation evidence: `10 PROVEN`
- Stable handoff operation contracts: `12`
- Reference, catalog, current state, geometry, provenance, nearby, in-area, and
  intersection behavior: `PASS`

## Scope security

- Static visible qualification: `PASS`
- Static hidden qualification: `PASS`
- `SIGNED_DELEGATION_V1` smoke and negative authorization cases: `PASS`
- Hidden reference, feature, result, and state isolation: `PASS`
- Final handoff and this report contain no token, password, private key, raw
  connection string, Provider URL, or container topology.

## Snapshot mutation and recovery

- Scenario: `move-ugv-002-to-zone-b`
- v1 to v2 mutation: `PASS`
- Pinned v1 replay after mutation: `FAILED AS EXPECTED`
- Gateway restart on v2: `PASS`
- Provider restart on v2: `PASS`
- PostgreSQL restart on v2: `PASS`
- Repeated mutation and idempotency verification: `PASS`
- Protected reset and reload restored the exact final v1 state: `PASS`

## Reset and fault compensation

- Protected reset: `PASS`
- Fixture-impact rows before reset: `610`
- Fixture-impact rows after reset: `0`
- Affected tables: `83`
- Non-fixture rows affected: `0`
- Data scopes preserved: `2`
- Migration rows preserved: `62 -> 62`
- Instance marker preserved: `1 -> 1`
- Injected first-load failure at `observation-insert`, count `3`: `PASS`
- Compensation: `PROTECTED_RESET_AND_VERIFIED_EMPTY`
- Compensation dry-run verification: `PASS`
- Non-fixture rows affected during compensation: `0`

## Consumer handoff

- Handoff qualification: `PASS`
- Consumer connectivity: `PASS`
- Consumer evidence source: `INDEPENDENT_CONTAINER`
- Qualified operation: `reference.get@1.0`
- Authentication mode: `SIGNED_DELEGATION_V1`
- Consumer realization and loaded-state hashes exactly match the final v1 binding.
- Runtime and handoff copies of load, canary, canary-evidence, and consumer
  connectivity reports are byte-identical.
- Handoff secret scan and Provider-topology exclusion: `PASS`

Contract identities:

- Contract catalog: `sha256:efd0395dbd05c884c781f964b22147efcb38c4cef91704597706ec4b8332075a`
- Binding revision: `sha256:1d59337bcbd8cb8dd76d0241d08b8c7618f61daa6e9c43d25db45c11994f1394`
- Semantic catalog: `sha256:418fc328861e846801c6e8109bf6d48b876c7814c650a391b84076f71e588b61`
- Operation lock: `sha256:765714690fc2192138f925526cc6bf0215c2481fa234c566756c26b891649686`

## Validation actually run

- Task-package validator: `PASS` (`schemas=7`, `sourceFeatures=9`, `objects=7`,
  `expectedCases=13`, `acceptance=111`)
- Contract generation check and TypeScript checks: `PASS`
- Consumer contract deterministic build/validation: `PASS` (`63` files)
- Full Vitest run: `59` files passed, `1` skipped; `379 PASS`, `1 SKIPPED`,
  `0 FAIL`
- Live semantic catalog, root consumer lock, and bundled manifest equality: `PASS`
- Independent container connectivity: `PASS`

## Task-package authority boundary

| Action or gate | Status |
|---|---|
| Local test data, runtime, canary, recovery, reset, and handoff | `PASS` |
| AC-F004 exact local/tracking/remote PR SHA | `NOT_RUN / NOT_AUTHORIZED` |
| AC-F005 create/update/ready PR | `NOT_RUN / NOT_AUTHORIZED` |
| Push | `NOT_RUN / NOT_AUTHORIZED` |
| PR publication | `NOT_RUN / NOT_AUTHORIZED` |
| Merge | `NOT_RUN / NOT_AUTHORIZED` |
| Tag | `NOT_RUN / NOT_AUTHORIZED` |
| Release | `NOT_RUN / NOT_AUTHORIZED` |
| Production deployment | `NOT_RUN / NOT_AUTHORIZED` |
| Production data load | `NOT_RUN / OUT_OF_SCOPE` |
| WSGS implementation changes | `NOT_RUN / OUT_OF_SCOPE` |

The package's protected-action negative gates, AC-B007 and AC-F006, pass because
no merge, tag, release, or deployment occurred.

## Emitted final markers

- `SAMPLE_WORLD_DATA_READY`
- `GOWM_WSGS_TEST_INSTANCE_READY`
- `GROUNDING_CORE_SAMPLE_CANARY_PASS`
- `WSGS_TEST_HANDOFF_READY`

The composite-only `GOWM_WSGS_SAMPLE_WORLD_TASK_COMPLETE` marker was not used as
evidence for this report; the equivalent lifecycle stages were executed and
verified separately so the already-notified WSGS consumer was not interrupted by
another rebuild.
