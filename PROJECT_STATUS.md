# Project status

Last updated: 2026-08-30

## Current candidate

GOWM+ **0.7.0 — Historical Trace & Effective Snapshot**. The local candidate is
split into `codex/gowm-v0.7-pr1-effective-snapshot` and the stacked
`codex/gowm-v0.7-pr2-task-trajectory`. Publication and merge state are reported
separately from source and runtime evidence.

The 0.7.0 decision is bound to fresh exact-source evidence under
`reports/gowm-v0.7`. Earlier reports and a running shared sample instance do not
prove this candidate.

## Historical v0.6.4 baseline

The v0.7 candidate incorporates the merged v0.6.4 Reference Composability
Repair. Its qualified baseline remains bound to its own exact-source evidence:

- Resolver descriptors bind to the corresponding immutable catalog/object
  version so their ReferenceKeys can be passed unchanged to current validation,
  geometry, world-state, and spatial operations.
- Additive migration 062 projects current LayerFeature geometry through the
  existing scoped read contract; migrations 001–061 remain frozen.
- Qualification uses a unique Compose project, database, ports, volumes, and
  image identity, with source revision embedded as OCI metadata.
- Readiness is derived from the task package's 61 required acceptance cases;
  the five WSGS cases are optional and must be reported consistently as one run.

Those v0.6.4 results establish the inherited baseline; they do not replace
fresh v0.7 qualification or authorize tag, release, package publication,
production deployment, or production SLO claims.

## Scope and authority

The formal registry contains 16 providers and 124 explicit Manifest 1.1
capabilities. Provider Execution Protocol remains 1.0. The catalog contains 31
Stable, 91 Preview, and 2 Experimental operations. The historical interval and
trajectory operations remain Preview. The generated v2 consumer lock has no
provider addresses, secrets, database names, or deployment topology.

Gateway projects and hashes provider-owned profiles. It does not infer domains,
units, references or relations from operation names. Vocabulary and S001–S014
rules are checked offline against schemas, ports, TypeScript, SQL AST and tests.
Foundation remains the fact authority and its write path is independent.
Network, Route and Coverage algorithms remain unchanged. Migrations 063–067 add
generic analysis inputs, runtime-discovered effective snapshots, task execution
intervals, Tracklet finalization, and historical trajectory contracts without
rewriting earlier migrations.

## Runtime and qualifications

The historical Provider is exposed only through the World Capability Gateway.
Its reads are scoped, bounded and pinned to an Effective Snapshot; materialized
revisions retain interval, Tracklet, finalization, method-profile and compute
lineage. The worker uses leases and generation fencing. These qualifications do
not promote the Preview capabilities or constitute production SLO/HA proof.

H3 bindings are reproducibly built from the locked upstream commit and checked
against the source-lock digest before import. H3 cover is a candidate operation;
exact Spatial verification uses the retained original geometry. World position
and Network directed-state ports make their actual schemas explicit. Coverage
resolves pinned area references through scoped views and rechecks area
currentness. Route LOGIN uses controlled write functions with no direct
fact/job-table mutation privilege.

## v0.7 evidence

- `reports/gowm-v0.7/pr1`: Effective Snapshot, generic analysis-input, restart,
  conflict and regression evidence.
- `reports/gowm-v0.7/pr2`: task interval, Tracklet finalization, historical
  trajectory, late-data, Gateway, scope-security and performance evidence.
- `packages/platform/world-gateway-contracts/bundle`: deterministic consumer
  schemas, OpenAPI, generated types, vocabularies, revisions, lock, and manifest.
- `database/migrations/063_analysis_resource_inputs.sql` through
  `067_historical_trajectory_contract.sql`: additive durable history model and
  scoped read/write contracts.

## Historical v0.6.2 evidence

- `reports/gowm-v0.6.2/baseline-runtime`: freshly rerun predecessor D00/G00/T00.
- `semantic-implementation-report.json` and 122 semantic attestations.
- `runtime`: real single-Gateway HTTP envelopes, compiled-image identity,
  PostgreSQL/process observations, boundary/H3/reference/snapshot/failure tests.
- `single-gateway-canary-report.json`: A–E status, including isolated H3 failure.
- `regression`: full TypeScript/schema/SQL/Vitest/STAS/build/compatibility gates.
- `d00-runtime-v062final.json`: 60 migrations, 43 SQL assertion suites and
  install/upgrade/replay/rollback checks against dedicated PostgreSQL.
- `final-acceptance-preflight.json` and `validation/gowm-v0.6.2/traceability.csv`:
  all 180 required criteria and their evidence.

One existing optional external-database Vitest test remains skipped. Required
PostgreSQL behavior is verified by the dedicated schema gate and actual
provider processes, not inferred from that skip or metadata-only unit tests.
No merge, tag, release, production deployment or other-repository change is
part of this task. See [operator guide](docs/architecture/WORLD_PLATFORM_GATEWAY_V0.6.2.md)
and [execution record](execplans/EP-gowm-v0.6.2-world-gateway-semantics.md).
