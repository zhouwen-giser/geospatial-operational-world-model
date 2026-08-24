# EP: GOWM+ Capability Platform v0.2

This is a living document. Status values are evidence based: `PASS`, `FAILED`,
`NOT_RUN`, and `BLOCKED` are not interchangeable.

## Purpose

Evolve GOWM+ from a fixed data/API platform into a three-layer capability
platform: Data Foundation, Capability Service Plane, and World Capability
Gateway. Integrate CRS, Geometry, H3, and Spatial Analysis through controlled
provider contracts without moving external provider source into this repository
or placing GIS algorithms in the Gateway.

## Source lock

- GOWM default branch: `codex/unify-gowm-stas-v0.1.0`
- GOWM baseline and remote HEAD: `d1ff3b81b8bf577965b00edc1bd06acaaeda706c`
- H3 Toolkit `main`: `74fc8657072dd58a2f8e4317c1caef8bfd10e024`
- H3 Toolkit version / engine: `0.3.0` / `h3-js 4.5.0`
- CRS ZIP: `3110e7b344d138908d27e759ede70701b8a20dd7bbbd9795b3a57d02b8d70995`
- Geometry ZIP: `3527a06d7a6216c1bf1c2ee75690824298231917c03a8c99507a71df26f12c3d`
- Spatial ZIP: `15cdaf00f3c5ee911eac1351c2d9a59ff06a5de93a176ce81b644b19ee5de322`
- Target branch: `codex/gowm-capability-platform-v0.2`

The immutable task package and external source checkouts live below ignored
`.intake/`. No expanded external provider source is a repository deliverable.

## Architecture invariants

1. Foundation is the sole writer of canonical observations and world facts.
2. Gateway performs governance, routing, persistence, and DAG orchestration; it
   contains no PROJ, GEOS, H3, PostGIS, MobilityDB, or STAS domain algorithms.
3. Providers do not call one another. Cross-capability composition is a typed
   Gateway DAG.
4. Observation ingest and projection do not synchronously depend on a remote
   Gateway or provider.
5. Generic computations emit receipts, not fabricated world evidence.
6. Every operation has a compute snapshot; data-bound operations additionally
   report an honest data snapshot.
7. H3 is a discrete index/candidate/aggregation mechanism. Exact spatial truth
   returns to Spatial/PostGIS.
8. Spatial reads only versioned `gowm_spatial_v1`, under a trusted SQL scope and
   a role with no canonical base-table privilege.
9. Provider endpoints are controlled registry configuration. User URLs, SQL,
   dynamic code, and arbitrary tool discovery are prohibited.
10. Migrations `001` through `010` are immutable; v0.2 starts at `011`.

## Phase progress

- [x] P00 - intake, source lock, non-container baseline, branch and reports
- [ ] P01 - ADR and corrected platform contracts
- [ ] P02 - incremental repository workspace
- [ ] P03 - provider SDK, conformance kit, and elevation mock
- [ ] P04 - registry and direct execution
- [ ] P05 - Foundation local ports and processing receipts
- [ ] P06 - CRS bridge
- [ ] P07 - Geometry bridge
- [ ] P08 - H3 bridges and JS/PG parity
- [ ] P09 - H3 Situation authority refactor
- [ ] P10 - public ReferenceKey and `gowm_spatial_v1`
- [ ] P11 - Spatial bridge
- [ ] P12 - typed query-plan runtime and persistence
- [ ] P13 - cross-capability machine evidence
- [ ] P14 - World API and MCP compatibility migration
- [ ] P15 - security, snapshot, and recovery gates
- [ ] P16 - real container/runtime acceptance
- [ ] P17 - complete matrix and final candidate

## Decisions

- Introduce the v0.2 layout incrementally. Existing services remain in place
  until compatibility adapters and parity tests prove replacement semantics.
- Treat task-package machine artifacts as design inputs, not blindly frozen
  runtime artifacts. P01 must replace placeholder DAG hashes and close the
  manifest/OpenAPI/type gaps before implementation.
- Keep CRS and Geometry provider runtime construction isolated because their
  project-level redistribution licenses are unspecified.
- Use the locked H3 Toolkit source/package contracts for generic H3 behavior;
  retain GOWM ownership only for Situation projection semantics.
- Keep PostgreSQL as Gateway job/idempotency/node-result storage. Do not add a
  queue or cache without measured need.

## Discoveries

- All three outer ZIP hashes and their internal manifests/checksum sets pass.
- The five supplied DAG examples contain placeholder schema hashes. They are
  invalid runtime evidence until P01 replaces them with generated real hashes.
- The supplied Gateway OpenAPI omits capability detail, job, and receipt reads;
  the Provider OpenAPI omits health/readiness and async job lifecycle.
- `WorldQueryPlanV2.inputs` and `preconditions` are untyped open objects and its
  nodes omit explicit budgets; the runtime contract must fail closed here.
- `elevation.sample.mock` and GOWM H3 Situation are not present in the supplied
  initial catalog and require controlled manifests.
- Spatial POC currently reads its own base table contract and lacks SQL scope,
  ReferenceKey, freshness, provenance, and honest snapshot semantics. A direct
  passthrough bridge cannot satisfy the platform contract.
- Existing root build is not an npm workspace; STAS has an independent lock and
  build. P02 must preserve this boundary while adding v0.2 packages.

## Failed attempts retained

- `bash scripts/preflight.sh .` first resolved to restricted WSL and failed.
- Direct Git Bash then found no usable `python3`; the WindowsApps alias returned
  permission denied. An ignored `.intake/preflight-bin/python3` compatibility
  shim allowed the unchanged script to finish with `PREFLIGHT_PASS`.
- `docker compose config --quiet` first failed because the required isolated
  project name and STAS password were absent. With process-local non-secret
  values and an ignored `DOCKER_CONFIG`, the same config check passed.
- Docker client was installed but the daemon was initially unavailable. Docker
  Desktop was started and the server probe now passes; no database/provider gate
  is marked passed until its real acceptance commands finish.
- GitHub CLI authentication is stale. Git transport remains separately tested;
  PR creation/update will use an authenticated browser session if needed.

## Actual validation

- Task package validator: `TASK_PACKAGE_VALID schemas=13 examples=5 acceptance=96`.
- Task package preflight: `PREFLIGHT_PASS`; three locked input hashes passed.
- GOWM source lock: remote default/head equals locked `d1ff3b8`, ahead/behind `0/0`.
- H3 source lock: remote `main` equals locked `74fc865` and isolated checkout is clean.
- `npm.cmd run verify`: PASS.
  - root tests: 25 passed, 1 database integration test skipped by its explicit flag;
  - STAS tests: 39 passed;
  - TypeScript, SQL AST verification, and production builds passed.
- `docker compose config --quiet` with isolated process-local variables: PASS.
- Isolated Compose build and startup: PASS; all seven long-running services are
  healthy/running and migrations `001` through `010` applied cleanly.
- Real PostgreSQL integration: PASS on PostgreSQL 18.4, PostGIS/Raster 3.6.4,
  MobilityDB 1.3.0, and H3/H3-PostGIS 4.5.0.
- Existing HTTP acceptance: PASS after correcting its asynchronous Mobility
  projection poll; every G1-G8 check passed without weakening an assertion.
- Real STAS HTTP suite: 15/15 tools PASS, persistence/replay and cross-scope
  denial PASS, and the 10,001-candidate cap is enforced.
- Observation to TrackletVersion to STAS: PASS with two sequences, one explicit
  UNKNOWN gap, and exact idempotent replay. MQTT delivery in that focused host
  test remains `PARTIAL_DURABLE_QUEUE_ONLY`, as reported by the test itself.

## Remaining work

Execute P01 through P17 in order. Each phase must leave code, actual tests,
machine-readable acceptance status, a phase report, and a semantic commit. A
fixture or static contract result never substitutes for a real provider/database
gate. Merge, tag, release, and production deployment remain explicitly out of
scope.
