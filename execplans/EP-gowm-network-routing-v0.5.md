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
- [ ] A01 Contracts
- [ ] D00 Database Image
- [ ] D01 Network Schema
- [ ] D02 Network Read Contract
- [ ] N00 Catalog Build Adapter
- [ ] N01 Topology/Directed Arc
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

## Failed attempts retained

- Initial `npm.cmd run verify` reached Vitest after all SQL AST checks, then failed one v0.4 manifest raw-byte hash assertion. Root cause: global Git for Windows `core.autocrlf=true` materialized a locked LF JSON blob as CRLF. The regression test was made OS-independent by hashing its canonical LF repository form; locked hashes and contract bytes in Git remain unchanged.

## Actual evidence

- `python scripts/validate_task_package.py`: `TASK_PACKAGE_VALID schemas=19 providers=2 examples=8 acceptance=155`
- Reference input `Get-FileHash`: exact locked SHA-256 match.
- `git rev-parse HEAD` and `git rev-parse origin/main`: both `db575f79c874a69f65a2043a7e463338524b713d` after fetch.

## Remaining work

Execute B01 through S01 in order. Required real-runtime gates remain `NOT_RUN` until exercised against the pinned database image.
