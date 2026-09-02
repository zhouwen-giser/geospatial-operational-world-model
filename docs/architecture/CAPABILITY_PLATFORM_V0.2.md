# GOWM+ Capability Platform v0.2 architecture

Status: **implemented in the working tree; real-runtime acceptance BLOCKED**

This document describes the v0.2 architecture as implemented. It does not
promote controlled fixtures or static checks to real Provider, PostgreSQL, or
container evidence. The authoritative status for each gate is the corresponding
machine-readable phase report under `reports/capability-platform-v0.2`.

## System model

```text
trusted caller
    |
    v
World Capability Gateway
    |-- controlled Registry and version/schema locks
    |-- identity, scope, policy, budget, idempotency, audit
    |-- direct execution and typed World Query DAG
    |
    +--> CRS bridge ----------> locked CRS process
    +--> Geometry bridge -----> locked Geometry worker pool
    +--> H3 interactive ------> locked H3 Toolkit
    +--> H3 analysis ---------> locked H3 Toolkit
    +--> GOWM H3 Situation ---> pinned-scope GOWM projection reads
    +--> Spatial bridge ------> read-only gowm_spatial_v1

GOWM Foundation ingest/projection
    |-- local CRS identity normalization
    |-- local immutable Geometry validation
    +-- transaction-local h3-pg
```

The three planes have separate authority:

1. The Data Foundation owns canonical observations, corrected time,
   measurements, objects, relations, immutable TrackletVersions, current
   projection, public reference identity, and versioned read contracts.
2. The Capability Service Plane owns execution of declared operations and any
   provider-local derived results, jobs, or caches. It cannot mutate Foundation
   facts or call another Provider.
3. The Gateway owns controlled registration, routing, policy, DAG/job state,
   execution receipts, and low-cardinality audit. It cannot implement domain
   algorithms or write Foundation facts.

## Contract boundary

Committed JSON Schemas in `contracts/platform` and `contracts/capabilities` are
the normative wire-contract source. Generated TypeScript, the runtime schema
bundle, and schema hashes are derived artifacts. Operation identity is
`operationId + operationVersion`, so multiple versions can coexist without
changing Gateway core.

A public `GatewayExecuteRequest` supplies the operation, version constraint,
input, idempotency key, deadline, and budget. It cannot supply a principal,
DataScope, DatasetScope, Provider URL, or internal attestation. The Gateway
derives those from the authenticated transport and controlled deployment
configuration, then constructs a separate `ProviderExecutionRequest`.

Each Provider validates protocol version, operation/version, input/output
schema hashes, deadline, effective budget, trusted scope attestation, request
shape, and result envelope independently. The Gateway revalidates Provider
identity, operation identity, schema identity, hashes, snapshots, receipts, and
actual output size on both fresh and replayed results.

## Registry and network boundary

Production registration is configuration-driven. The checked-in Registry binds
each Provider identity and implementation digest to an approved endpoint and
manifest hash. A Provider manifest contains only relative protocol paths; it
cannot authorize its own absolute endpoint.

Gateway HTTP clients reject credentials, query strings, fragments, redirects,
backslashes, network-path references, and any resolved path that changes the
configured origin. Plain HTTP for single-label container hosts requires an
explicit deployment flag. Callers cannot supply URLs, arbitrary SQL, dynamic
code, or MCP catalogs.

## Direct execution and World Query

Direct execution performs controlled version resolution, maturity/scope policy,
schema validation, deadline and budget enforcement, health/circuit isolation,
idempotency, Provider invocation, result revalidation, persistence, and audit.
One unhealthy Provider does not make unrelated capabilities unavailable.

World Query v2 is an orchestration contract, not a GIS language. A node fixes:

- operation ID/version and input/output schema hashes;
- typed literal, request-path, node-output, ReferenceKey, dataset-version, or
  artifact bindings;
- preconditions and failure policy;
- per-node budgets within plan and system budgets.

Validation rejects cycles, dangling dependencies, port/schema mismatches,
scope expansion, unsupported snapshot policy, exact-geometry use of candidate
H3 output, and coordinate-unit buffers presented as metres. Composite request
construction supports bounded rooted JSON Pointer targets; duplicate/prefix
collisions, unsafe prototype segments, excessive depth, and whole-request
targeting fail closed. The complete constructed request is validated against
the registered operation schema before execution.

The runtime supports synchronous execution and queued jobs, persisted node
states/hashes, fail-fast or explicit partial behavior, cancellation, leases,
and bounded worker claims. A late Provider result cannot overwrite a cancelled
job. Expired work is reclaimable through PostgreSQL lease semantics, but real
process/database restart recovery remains an outstanding runtime gate.

## Snapshot, receipt, and evidence semantics

These objects are intentionally different:

| Object | Meaning | Required boundary |
|---|---|---|
| Compute Snapshot | Provider, engine, operation, policy, schema, and deployable digest used for computation | Required for every completed operation |
| Data Snapshot | Consistency and versions of world/dataset resources read | Only for data-bound operations |
| Execution Receipt | Append-only method record with input/output hashes, duration, warnings, and repair/type-change details | Computation provenance; never World Evidence by itself |
| Evidence Reference | Reference to an Observation, WorldEvent, TrackletVersion, Dataset/Layer version, AnalysisRecord, or current-projection source | Only when authoritative/versioned data supports the result |

World-independent CRS, Geometry, and generic H3 work has a Compute Snapshot and
Receipt but no fabricated Data Snapshot, World Version, or Evidence. Spatial
and Situation results carry honest data-bound context.

## Capability ownership

| Capability | Algorithm authority | Data authority | Exactness |
|---|---|---|---|
| CRS | Locked external CRS process; Foundation local path supports only canonical EPSG:4326 identity | Caller input | Transformation, subject to locked offline grid/policy attestation |
| Geometry | Locked external GEOS worker process; Foundation local path validates immutably | Caller input | Exact within declared coordinate-space semantics |
| H3 kernel/analytics | H3 Spatial Toolkit `0.3.0` / h3-js `4.5.0`; Foundation local projection uses h3-pg | Caller input | Discrete index, coarse candidate, aggregation, or derived flow |
| GOWM H3 Situation | Foundation projection owns World Version and metric profile; generic grid math delegates to the locked local adapter | GOWM current projection | Candidate/projection semantics, not exact topology |
| Spatial | Original GOWM bridge using parameterized PostGIS queries | `gowm_spatial_v1` only | Exact topology and metric distance under the declared contract |
| STAS | Independent STAS deterministic analysis runtime | `gowm_stas_v1` plus append-only AnalysisRecords | Application-specific derived analysis |

H3 flow consumes separate MobilityDB sequences and cannot create a transition
across an `UNKNOWN` gap. H3 polygon cover declares center containment,
`candidateOnly=true`, and `exactVerificationRequired=true`; Spatial/PostGIS
performs the boundary-sensitive exact step.

## Persistence and least privilege

Migrations `001`-`010` are immutable. v0.2 appends:

| Migration | Purpose |
|---|---|
| `011_capability_gateway_persistence.sql` | Controlled Registry, idempotency, health/circuit, receipts/evidence, jobs, and audit |
| `012_gowm_spatial_v1_read_contract.sql` | Opaque ReferenceKey identity, scope-filtered read contract, read-only Spatial role, and Foundation processing receipts |
| `013_world_query_runtime_persistence.sql` | World Query/node state, hashes, transitions, leases, and claims |
| `014_capability_runtime_service_principals.sql` | Separate NOLOGIN membership roles for Gateway runtime, short-lived Registry bootstrap, Spatial, and pinned-scope Situation service identities; updated lease recovery |

Deployment provisions distinct LOGIN principals and secrets. The long-lived
Gateway runtime cannot administer Registry routes; the Registry bootstrap pool
is short-lived and closed after synchronization. Spatial uses a dedicated
read-only pool and has no base-table privileges. Situation reads are separately
restricted and currently fail closed outside the configured single-scope model.

## Compatibility

Legacy `/spatial/*` and `/situation/*` reads remain available during migration.
Dual-run mode compares result and semantic hashes, preserves the legacy result
on mismatch/failure, and requires an explicit parity attestation before a route
can switch to Gateway mode. Deprecation and Sunset headers make the migration
visible without maintaining a second SQL or H3 algorithm.

MCP is split into a fixed read/analysis surface backed by the Gateway and a
separate Observation command surface backed by ingest. The read-only service
contains no publish tools and trusts no dynamic tool catalog.

## Source and release boundary

- CRS source ZIP SHA-256:
  `3110e7b344d138908d27e759ede70701b8a20dd7bbbd9795b3a57d02b8d70995`.
- Geometry source ZIP SHA-256:
  `3527a06d7a6216c1bf1c2ee75690824298231917c03a8c99507a71df26f12c3d`.
- Spatial source ZIP SHA-256:
  `15cdaf00f3c5ee911eac1351c2d9a59ff06a5de93a176ce81b644b19ee5de322`.
- H3 Toolkit source commit:
  `74fc8657072dd58a2f8e4317c1caef8bfd10e024`.

Expanded external source remains ignored and must not be committed. CRS and
CRS and Geometry are project-owned MIT POCs; their approved curated source,
packages, and images may be published with locked provenance, Notice, and SBOM
artifacts. H3 and Spatial retain Apache-2.0 Notice and SBOM artifacts.

## Evidence boundary and current qualification

Controlled unit, contract, conformance, architecture, and in-process DAG tests
exercise the implementation. They are not a substitute for the Required real
runtime matrix. As of 2026-08-23, the following remain `NOT_RUN` or `BLOCKED`:

- fresh and upgraded PostgreSQL execution of v0.2 migrations and assertions;
- real CRS and Geometry processes, real H3 Toolkit API, and real Spatial reads;
- H3 JS/PG parity, exact cross-capability DAGs, and scope adversarial tests in
  the same live stack;
- Provider/Gateway/database restart and idempotent recovery;
- container health/readiness/non-root proof for the v0.2 services;
- production identity provider, operating-area CRS/grid certification, HA,
  backup/PITR rehearsal, and target mixed-load/SLO proof;
- semantic phase commits, push parity, and PR Ready-for-Review.

The final decision therefore remains `BLOCKED`; Draft PR #1 must remain Draft.
No merge, tag, release, or deployment has been performed.
