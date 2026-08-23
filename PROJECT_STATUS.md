# Project status

Last updated: 2026-08-23

## Current decision

`GOWM+ Capability Platform v0.2: BLOCKED`

The v0.2 framework is implemented and has substantial controlled verification
in the working tree. It is not a deliverable candidate: required live-runtime
gates remain `NOT_RUN/BLOCKED`, and the implementation is not represented by a
committed and pushed SHA.

The previous v0.1.0 baseline and evidence remain preserved. Its decision was
`INTEGRATION_CONDITIONAL_PASS`; it was not a production qualification.

## Source and Git state

| Item | Current state |
|---|---|
| Base | `codex/unify-gowm-stas-v0.1.0` at `d1ff3b81b8bf577965b00edc1bd06acaaeda706c` |
| Working branch | `codex/gowm-capability-platform-v0.2` |
| Last committed local SHA | `e100cc0fd0b7b27f8a386232dc2b261de7841547` |
| Last pushed remote SHA | `e100cc0fd0b7b27f8a386232dc2b261de7841547` |
| v0.2 implementation state | Uncommitted working-tree changes; no candidate SHA covers the implementation |
| Pull request | [Draft PR #1](https://github.com/zhouwen-giser/geospatial-operational-world-model/pull/1); must remain Draft |
| Merge/tag/release/deploy | `NOT_RUN`; protected user-controlled actions |

The matching committed local/remote SHA does not satisfy AC-095 because it does
not include the current v0.2 implementation. Semantic phase commits, pushes,
and PR updates are blocked by the current Git-index/escalation constraint; no
alternate index or history-rewriting workaround was used.

## Phase status

`PASS` below means the phase's claimed evidence class passed. `PARTIAL` means
the implementation may be present while a required real environment or
delivery step remains outstanding.

| Phase | Status | Current boundary |
|---|---|---|
| P00 Intake/baseline | PASS | Input/source locks and the v0.1 real baseline were verified; Draft PR created |
| P01 Contracts/ADR | PARTIAL | Generated contracts and policy tests pass; final live OpenAPI/runtime parity is not yet consolidated |
| P02 Repository framework | PARTIAL | Build/test/boundary checks pass; commit/push delivery is blocked |
| P03 Provider SDK/conformance | PARTIAL | Controlled conformance passes; PostgreSQL-backed idempotency/restart is not run |
| P04 Gateway direct execution | PARTIAL | Controlled routing, health isolation, circuit, audit, and error identity pass; real PostgreSQL/restart is not run |
| P05 Foundation local ports | PARTIAL | Local-only critical path and rollback-before-mutation behavior pass; live receipt/h3-pg outage proof is incomplete |
| P06 CRS bridge | PARTIAL | Bridge/contracts/guards pass; locked real CRS process and grid cases are not run |
| P07 Geometry bridge | PARTIAL | Bridge/contracts/unit and policy guards pass; real worker process timeout/overload cases are not run |
| P08 H3 bridge | PARTIAL | Locked integration, QoS, candidate semantics, and controlled tests pass; real Toolkit API and JS/PG parity are blocked |
| P09 H3 Situation refactor | PARTIAL | Generic H3 delegates to one locked local authority; post-change real HTTP regression is not run |
| P10 `gowm_spatial_v1` | PARTIAL | Contract, static role, and migration immutability checks pass; live fresh/upgrade/scope assertions are not run |
| P11 Spatial bridge | PARTIAL | Parameterized contract-only implementation passes controlled checks; real correctness/index/mixed-load gates are not run |
| P12 World Query runtime | PARTIAL | Typed DAG, budgets, persistence API, and controlled recovery pass; real PostgreSQL restart/resume is not run |
| P13 Cross-capability | PARTIAL | Required chains pass with controlled Provider runtimes; external services/PostgreSQL chain is not run |
| P14 Compatibility/MCP | PARTIAL | Read-only/command split and controlled compatibility pass; real dual-run is not run and multi-scope Situation is blocked |
| P15 Security/snapshot/recovery | PARTIAL | Controlled adversarial, redaction, cancellation, and integrity tests pass; real DB scope/idempotency/restart is not run |
| P16 Real runtime | BLOCKED | Docker/external Provider/PostgreSQL credentials are unavailable for the required integrated run |
| P17 Final candidate | BLOCKED | Required real matrix and Git delivery are incomplete; PR cannot become Ready |

Detailed commands and evidence classifications are recorded in
`reports/capability-platform-v0.2/pXX-acceptance.json`. Controlled fixtures,
static SQL parsing, and in-process Provider runtimes are not treated as real
Provider, database, or container evidence.

## Implemented platform boundary

- JSON-Schema-first Provider/Gateway/World Query contracts with generated
  TypeScript and schema hashes.
- Provider SDK and conformance kit, plus an `elevation.sample.mock` extension
  example requiring no operation-specific Gateway code.
- Controlled six-Provider Registry, 50 declared operations, direct execution,
  circuit/health isolation, idempotency, audit, typed DAG execution, jobs,
  cancellation, and durable store implementations.
- Local Foundation CRS/Geometry/H3 ports with transaction-coupled processing
  receipts and no synchronous remote dependency.
- CRS, Geometry, H3 interactive/analysis, GOWM H3 Situation, and Spatial
  bridges with separate operation, scope, budget, and snapshot semantics.
- Opaque ReferenceKeys, `gowm_spatial_v1`, parameterized exact Spatial queries,
  and least-privilege runtime/registry/read roles.
- Legacy World read adapters and a split read-only versus Observation-command
  MCP boundary.

## Active blockers and non-claims

1. The current sandbox cannot create `.git/index.lock`; the authorized
   escalated Git operation is unavailable under the execution-platform usage
   limit. The v0.2 work therefore has no semantic phase commits or pushed
   candidate SHA.
2. The reachable isolated PostgreSQL endpoint rejected available credentials
   with SQLSTATE `28P01`. Creating a replacement Docker environment is also
   unavailable in the current execution session.
3. The locked CRS and Geometry Provider processes have not run in the required
   integrated environment. Their project-level licenses remain unspecified, so
   upstream source, packages, and images are excluded from GOWM+ release
   artifacts regardless of runtime availability.
4. Real H3 Toolkit HTTP and h3-js/h3-pg parity, Spatial/PostGIS correctness and
   plan evidence, all required cross-capability DAGs, scope attacks, and
   Provider/Gateway/database restart recovery have not been proven together.
5. Production IdP/auth, operating-area CRS and grid certification, HA,
   backup/PITR rehearsal, and target mixed-load/SLO qualification are outside
   the evidence obtained in this run.

## Required next actions

1. Restore an authorized Git-index path; review and commit the phase changes
   without rewriting or discarding unrelated work, then push them.
2. Provision a clean isolated runtime with distinct database secrets and the
   locked external Provider inputs. Do not publish CRS or Geometry upstream
   artifacts.
3. Apply the full migration chain to fresh and upgraded databases, run database
   assertions, start all Provider/Gateway services, and capture health,
   readiness, non-root, source-lock, and schema-lock evidence.
4. Run the Required real direct-operation, DAG, exact H3-to-Spatial, scope,
   restart/idempotency, and load/plan gates. Keep failures and skips explicit.
5. Re-run the full repository gates, update phase/final evidence, and verify an
   exact local/remote SHA. Only with zero undeclared Required failures or skips
   may the PR be marked Ready for Review.

Do not merge, tag, release, or deploy automatically.
