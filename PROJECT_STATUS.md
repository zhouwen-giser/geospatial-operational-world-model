# Project status

Last updated: 2026-08-31

## v0.7.1 source and qualification state

GOWM+ **0.7.1 — Protocol and Runtime Closure** separates source integration,
static verification, runtime qualification and publication. This document
records repository capabilities; it does not infer a transient branch, pull
request or qualification state.

The authoritative integration state is the repository ref and pull-request
metadata. Exact-head qualification is authoritative only when the post-merge
workflow runs at `GITHUB_SHA` and publishes an immutable artifact bound to that
commit and tree. Local candidate reports and a running shared sample instance
do not prove the current source revision.

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
Network, Route and Coverage algorithms remain unchanged. The additive migration
sequence is:

- `063_effective_query_snapshot.sql`
- `064_analysis_resource_inputs.sql`
- `065_task_execution_intervals.sql`
- `066_tracklet_finalization_runtime.sql`
- `067_historical_trajectory_contract.sql`
- `068_effective_snapshot_consistency_downgrade.sql`

Migrations 001–067 remain byte-frozen. Migration 068 corrects the persisted
Effective Snapshot constraint so an explicitly authorized consistency downgrade
can be recorded without changing query identity, mode, minimum world version, or
Data Scope membership.

The historical trajectory foundation is not the same as complete Historical
Reasoning. The following capabilities remain explicitly outside the candidate:

| Capability | Status |
| --- | --- |
| Map Matching | `NOT_IMPLEMENTED` |
| Temporal-Spatial Events | `NOT_IMPLEMENTED` |
| Historical Metric Ranking | `NOT_IMPLEMENTED` |

## Runtime and qualifications

The historical Provider is exposed only through the World Capability Gateway.
Its reads are scoped, bounded and pinned to an Effective Snapshot; materialized
revisions retain interval, Tracklet, finalization, method-profile and compute
lineage. It returns `trajectoryReferenceKey`, a bounded preview, gaps and
completeness. A scope-aware complete-trajectory Artifact round trip is not
implemented, so v0.7.1 deliberately omits `artifactReference` and reports
`GOWM_V071_HISTORICAL_ARTIFACT_DEFERRED`. The worker uses leases, generation
fencing and bounded retry backoff. These source properties do not promote the
Preview capabilities or constitute runtime, production SLO or HA proof.

H3 bindings are reproducibly built from the locked upstream commit and checked
against the source-lock digest before import. H3 cover is a candidate operation;
exact Spatial verification uses the retained original geometry. World position
and Network directed-state ports make their actual schemas explicit. Coverage
resolves pinned area references through scoped views and rechecks area
currentness. Route LOGIN uses controlled write functions with no direct
fact/job-table mutation privilege.

## v0.7 historical candidate evidence

- `reports/gowm-v0.7/pr1` and `reports/gowm-v0.7/pr2` are retained as
  `HISTORICAL_CANDIDATE_ONLY`; they are not authoritative for the current HEAD.
- `reports/gowm-v0.7/EVIDENCE_STATUS.json` records this evidence downgrade.
- `packages/platform/world-gateway-contracts/bundle`: deterministic consumer
  schemas, OpenAPI, generated types, vocabularies, revisions, lock, and manifest.
- `database/migrations/063_effective_query_snapshot.sql` through
  `068_effective_snapshot_consistency_downgrade.sql`: additive durable history
  model, scoped read/write contracts, and monotonic consistency downgrade
  persistence.

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
Tagging, release, package publication, production deployment, production SLO or
HA claims, and other-repository changes remain outside this task. See
[operator guide](docs/architecture/WORLD_PLATFORM_GATEWAY_V0.6.2.md) and
[execution record](execplans/EP-gowm-v0.6.2-world-gateway-semantics.md).
