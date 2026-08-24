# EP: GOWM+ Network & Basic Routing v0.5

This is a living execution plan. It records only evidence produced from the actual repository and runtime.

## Purpose

Extend the GOWM+ 0.4 data foundation with one authoritative, immutable network graph foundation, read-only network and basic route-planning capabilities, an independent route verifier, and Gateway/Derived Result integration.

## Actual main baseline

- Reconciled at: 2026-08-24 (Asia/Shanghai)
- Repository: `zhouwen-giser/geospatial-operational-world-model`
- Actual fetched `origin/main`: `db575f79c874a69f65a2043a7e463338524b713d`
- Actual `VERSION`: `0.4.0`
- Baseline merge: PR #2 merge commit `db575f79c874a69f65a2043a7e463338524b713d`
- Candidate branch: `codex/gowm-network-routing-v0.5`
- Pre-existing worktree state: clean before task-package extraction
- Migrations 001-032: locked byte-for-byte in `reports/gowm-v0.5/baseline-migration-lock.json`

## Source and license locks

- Reference archive SHA-256: `a8b04ac9a6d6660d3042f4ba9030b0bb0b99b11a8f301a47dbfd12c8796ce116`
- License status: `UNSPECIFIED`
- Decision: `REFERENCE_ONLY_SELECTIVE_REIMPLEMENTATION`
- Expanded reference source, `node_modules`, `dist`, coverage artifacts, and legacy planner schema are excluded.

## Architecture invariants

- Network GraphVersion belongs to the GOWM+ Data Foundation.
- Route Provider never owns or copies a second authoritative graph.
- Providers do not call each other and read only through `gowm_network_v1`.
- Graph build/validation/activation is a protected management path.
- Graph and profile versions are immutable; conditions are versioned snapshots.
- Every route pins a complete RoutingSnapshot and remains `revalidationRequired=true`.
- Fixed-point integers are authoritative for distance, duration, risk, energy, and combined cost.
- Multi-edge turn semantics use a product-state/sequence automaton and an independent verifier.
- Gateway contains no pgRouting SQL or routing algorithms.

## Progress

- [x] B00 Baseline Reconciliation
- [x] B01 Source Lock
- [x] A00 Architecture ADR
- [x] A01 Contracts
- [x] D00 Database Image
- [x] D01 Network Schema
- [x] D02 Network Read Contract
- [x] N00 Catalog Build Adapter
- [x] N01 Topology/Directed Arc
- [ ] N02 Turn Restrictions
- [ ] N03 Profiles/Costs/Conditions
- [ ] N04 Validation/Activation
- [ ] P00 Network Provider
- [ ] P01 Network Real Acceptance
- [ ] R00 Route Runtime
- [ ] R01 Basic Route Plan
- [ ] R02 Independent Verifier
- [ ] R03 Results/Alternatives Preview
- [ ] G00 Gateway Integration
- [ ] T00 Security/Performance/Recovery
- [ ] S00 Documentation/Version
- [ ] S01 Final Candidate

## Decisions

- Use actual fetched main because it is the compatible 0.4.0 stable baseline named by the task.
- Keep the extracted Codex task package untracked as user-supplied execution input.
- Reimplement permitted concepts against GOWM contracts; do not copy the unlicensed reference implementation.
- Never downgrade the required pgRouting 4.0.1 gate to accommodate an unavailable runtime.

## Discoveries

- The repository starts with migrations 001-032 and the v0.4 stable contract/runtime.
- The existing migration lock covers only 001-014, so v0.5 records an additional immutable 001-032 lock without changing the older lock.
- The supplied reference archive has no redistributable license declaration; every permitted concept is mapped to a clean-room implementation target and all coverage-planning lifecycle/solver artifacts are excluded.
- The existing generator previously dropped base object properties when a schema also used `oneOf`; A01 now merges base and branch requirements so generated route request types preserve every mandatory field.
- Docker Desktop 4.81.0 could not start because four stale Windows Unix-socket reparse points survived a prior crash. A controlled process/WSL cold restart and exact transient-socket cleanup restored Docker Engine 29.6.1 without deleting images, containers, configuration, or volumes.
- D00 built and exercised the required composite database image. PostgreSQL 18.6, PostGIS 3.6.4, MobilityDB 1.3.0, h3/h3_postgis 4.5.0, and pgRouting 4.0.1 coexist; all baseline migrations and assertions pass in the image.
- D01 adds migrations 033-038 and proves them from an empty database through run `d01-20260824t2359`; the model uses immutable directed topology, versioned conditions, source Feature bindings, fixed-point costs, and append-only activation events.
- D02 adds migration 039 as the only Provider SQL surface. Eleven security-barrier views and five controlled functions enforce transaction-local DataScope/DatasetScope, base-table denial, bounded directed snapping, complete snapshot resolution, and route-planner-only projection.
- N00 adds a Foundation-owned Catalog adapter with fixed scoped queries, deterministic fixed-point materialization, stable graph-internal key primitives, and an OSM artifact path explicitly constrained to PREVIEW.
- N01 adds deterministic topology segmentation and least-privilege PostgreSQL persistence. Real execution exposed missing schema visibility for `network_builder`; append-only migration 040 repairs only schema `USAGE` and assertion 025 prevents mutable grant expansion.

## Failed attempts retained

- Initial `npm.cmd run verify` reached Vitest after all SQL AST checks, then failed one v0.4 manifest raw-byte hash assertion. Root cause: global Git for Windows `core.autocrlf=true` materialized a locked LF JSON blob as CRLF. The regression test was made OS-independent by hashing its canonical LF repository form; locked hashes and contract bytes in Git remain unchanged.

## Actual evidence

- `python scripts/validate_task_package.py`: `TASK_PACKAGE_VALID schemas=19 providers=2 examples=8 acceptance=155`
- Reference input `Get-FileHash`: exact locked SHA-256 match.
- `git rev-parse HEAD` and `git rev-parse origin/main`: both `db575f79c874a69f65a2043a7e463338524b713d` after fetch.
- D00 runtime run `gowm-v05-d00-20260824t2245-codex`: 63/63 recorded commands passed; image content digest `sha256:a502c7ce9ef773b4e0f4097ade3b88172f901d1e2d17ed246932d38a04026fae`.
- D01 runtime run `d01-20260824t2359`: 65/65 recorded commands passed; migrations 001-038 and assertions 001-023 passed in fresh database `gowm_v05_d01_20260824t2359`.
- D02 runtime run `d01-d02-20260824t2353`: 67/67 recorded commands passed; migrations 001-039 and assertions 001-024 passed in fresh database `gowm_v05_d01_d02_20260824t2353`.
- N01 runtime run `n01-20260825t0101`: migrations 001-040 replayed in a fresh database; 25 Nodes, 14 Edges and 27 directed Arcs persisted through the real builder role with reproducible hashes and all orientation checks passing.

## Remaining work

Execute N02 through S01 in order. N01 real topology persistence is complete; turn semantics and routing runtime gates remain `NOT_RUN` until their phases are implemented.
