# Project status

Last updated: 2026-10-12

## October capability completion candidate

Additive migrations 090–093 now implement full historical trajectory Artifact
open/read, scoped H3 projection and reads, immutable ingest profiles, calibrated
source clocks and controlled session cutover. Optional TLS/mTLS and MQTT ACL
configuration, scoped diagnostics and consistent logical backup/isolated restore
are executable. Migrations 001–089 and legacy historical contracts remain frozen.

Local fresh/089 upgrade tests exercise real PostgreSQL, the public Provider
protocol, two scopes, profile replay and logical restore. Physical clock evidence,
normal cross-repository business acceptance, onsite deployment, WAL/PITR and HA
remain unqualified. Adjacent SMPP/SDAR and analysis implementations are audited
separately; local source presence is not onsite acceptance. See the
[capability and upgrade guide](docs/CAPABILITY_COMPLETION_2026_10.md),
[integration handoff](docs/CAPABILITY_INTEGRATION_HANDOFF.md) and
[operations guide](docs/PRODUCTION_OPERATIONS.md).

## Earlier October functional repair candidate

Additive migrations 087–089 and `business_api_v2.sql` implement the F01–F05
repair: aligned default scope and service environment, automatic native storage,
actual-login controlled device admission/associations, gap-aware REST/MCP
trajectory analysis and a durable SSE delivery cursor. The prior 001–086 and
native SQL are locked to bytes from the retained release archive.

The local fresh/086 upgrade gate uses real PostgreSQL, managed SMPP/SDAR logins,
REST/MCP and SSE; it is not external business acceptance. Package and image
checks are recorded separately in the local functional repair report. No
sz-gowm deployment or queue recovery is part of this delivery. The follow-up
milestones and their remaining external boundaries are recorded above.
See [the repair and upgrade guide](docs/FUNCTIONAL_REPAIR_2026_10.md).

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

The current source registry contains 16 providers and 126 explicit Manifest 1.1
capabilities. Provider Execution Protocol remains 1.0. The catalog contains 31
Stable, 93 Preview, and 2 Experimental operations. The historical interval and
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
- `069_task_execution_event_set_read_contract.sql`

Migrations 001–068 remain byte-frozen. Migration 068 corrects the persisted
Effective Snapshot constraint so an explicitly authorized consistency downgrade
can be recorded without changing query identity, mode, minimum world version, or
Data Scope membership. Migration 069 adds a scoped, capturedAt-bounded read
function that computes the current operational-task event-set hash from the same
canonical event fields and ordering used by interval projection without granting
the history reader direct access to operational event base tables.

The historical trajectory foundation is not the same as complete Historical
Reasoning. The following algorithms live in the adjacent analysis repository;
they are not duplicated or qualified by this GOWM candidate:

| Capability | Status |
| --- | --- |
| Map Matching | `ADJACENT_IMPLEMENTATION / BUSINESS_ACCEPTANCE_NOT_RUN` |
| Temporal-Spatial Events | `ADJACENT_IMPLEMENTATION / BUSINESS_ACCEPTANCE_NOT_RUN` |
| Historical Metric Ranking | `ADJACENT_IMPLEMENTATION / BUSINESS_ACCEPTANCE_NOT_RUN` |

## Runtime and qualifications

The historical Provider is exposed only through the World Capability Gateway.
Its reads are scoped, bounded and pinned to an Effective Snapshot; materialized
revisions retain interval, Tracklet, finalization, method-profile and compute
lineage. It returns `trajectoryReferenceKey`, a bounded preview, gaps and
completeness. The legacy operation still omits `artifactReference` and reports
`GOWM_V071_HISTORICAL_ARTIFACT_DEFERRED` under its frozen contract. Separate
Preview open/read operations expose a scope-aware full Artifact with a versioned
consumer lock; they do not promote the old formal qualification. The worker uses leases, generation
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
  `069_task_execution_event_set_read_contract.sql`: additive durable history
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
