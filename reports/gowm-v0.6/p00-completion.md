# P00 Coverage Provider Protocol Completion

## Phase / scope

P00 adds the platform-native `gowm.road-coverage-planning` Provider protocol. The service exports an injected `RoadCoverageEngine` boundary and delegates all five frozen operations through the existing Provider SDK; it does not embed a second Gateway, Job API, graph authority, or Provider client.

## Frozen operation surface

| operation | maturity | execution |
|---|---|---|
| `coverage.road.validate` | Stable | sync |
| `coverage.road.select-obligations` | Stable | sync |
| `coverage.road.plan` | Stable | async Gateway Job |
| `coverage.road.verify` | Stable | sync or async |
| `coverage.road.expand-geojson` | Stable | sync |

All input/output hashes are verified against the exact committed schema bytes. Every descriptor requires DataScope, a pinned Data Snapshot, and a Compute Snapshot. The plan descriptor includes `ASYNC_JOB`; the generic `/v1/jobs/{jobId}` path remains the only job endpoint.

## Protocol semantics

- Provider SDK validation, schema locks, cost budgets, deadlines, idempotency, scope attestation, result envelope, and computation receipts are reused unchanged.
- Receipts and evidence remain separate envelope fields; the Coverage operation output cannot fabricate SDK receipts.
- The result-set contract contains identities, segments, fixed metrics, TTL, and revalidation state but no full geometry. `coverage.road.expand-geojson` is the explicit on-demand geometry operation.
- The Provider source contains no Network/Route Provider HTTP dependency and no WSGS/SACS/SDAR/SMPP/A2A dependency.

## Tests actually run

| gate | result | evidence |
|---|---|---|
| focused Provider protocol tests | PASS, 4 tests | manifest, byte hashes, modes/bindings, snapshots, envelope separation |
| machine Provider protocol gate | PASS, 13 checks / 5 operations | `p00-provider-p00-20260825t1120.json` |
| full repository Vitest regression | PASS, 237 tests | 46 files passed; one pre-existing optional file/test skipped |
| strict build/typecheck | PASS | root TypeScript and STAS |

The first focused protocol run failed before test execution because the new service imports/tsconfig traversed one directory too far. After correcting the workspace-relative paths, the next execution reached the contract; its first request was truthfully rejected because the packaged example wrapper, not its `value`, was submitted. The corrected request uses the authoritative example value and passes.

## Acceptance IDs

`AC-P001`, `AC-P002`, `AC-P012`, `AC-P013`, `AC-P014`, `AC-P017`, and `AC-P018` are PASS. `AC-P003..AC-P011`, `AC-P015`, and `AC-P016` remain `NOT_RUN` until G00/T00 exercises the real Gateway, Provider engine, worker, PostgreSQL result registry, TTL, DAG errors, and outage isolation.

## Commit / push / PR

P00 is delivered as a semantic phase commit, pushed, and reflected in Draft PR #4.

## Blockers / next

No Provider protocol blocker. Proceed to G00 to implement the real engine adapter and Gateway/DAG/result-registry integration.
