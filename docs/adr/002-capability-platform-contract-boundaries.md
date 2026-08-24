# ADR-002: Capability Platform trust, ownership, and contract boundaries

- Status: Accepted
- Date: 2026-08-23

## Context

GOWM+ is adding independently deployable CRS, Geometry, H3, and Spatial
capabilities. A reusable Gateway must route and compose these operations without
becoming a second domain engine or a second authority for Foundation facts.
The initial task-package schemas mixed an untrusted public request with the
trusted Provider request, embedded duplicate JSON Schema identifiers, and left
receipt/evidence and data/compute snapshot rules too permissive to enforce.

## Decision

Committed JSON Schemas under `contracts/platform` and
`contracts/capabilities` are the single normative source for wire contracts.
Generated TypeScript types and the runtime schema bundle are reproducibly
derived from those files. Runtime validation is fail closed, resolves committed
references, rejects unknown properties, and enforces date, date-time, URI, and
UUID formats.

The public `GatewayExecuteRequest` contains no principal, identity, role,
DataScope, DatasetScope, Provider URL, or Registry routing field. The Gateway
derives identity and scope from its authenticated transport, resolves only an
approved Registry endpoint, applies policy, and constructs a distinct internal
`ProviderExecutionRequest` with a time-bounded scope attestation. Providers
validate that internal request again.

Provider manifests declare only relative protocol paths and operation
descriptors. They are not self-authorizing. The controlled capability catalog
separately binds a Provider to an approved absolute endpoint and health policy.
Operation ID plus operation version is the coexistence key; schemas are pinned
with SHA-256 digests.

Every completed computation has a `ComputeSnapshotContext` and an
`ExecutionReceipt`. A receipt records method, engine, duration, hashes,
warnings, repair, and type changes. It is not World Evidence. A
`DataSnapshotContext` is absent for world-independent work and present only for
versioned data-bound work. `EvidenceReference` is limited to an authoritative
or versioned data reference and cannot represent an execution receipt.

World Query submissions carry parameters separately from the immutable plan.
Each DAG input uses exactly one typed binding: literal, request path, node
output, reference key, dataset version, or artifact reference. Nodes and the
whole plan have explicit budgets. Semantic validation additionally rejects
cycles, duplicate node IDs, dangling output references, incompatible port
hashes/value kinds/units, and node budgets above the plan budget.

Gateway code may implement Registry, authentication/scope, policy, budgets,
idempotency, routing, jobs, DAG orchestration, and audit. It must not implement
PROJ, GEOS, H3, PostGIS, MobilityDB, or STAS algorithms, execute arbitrary SQL,
accept arbitrary URLs, or dynamically discover tools. Providers do not call
other Providers. Foundation ingest and projection depend only on embedded or
local adapter interfaces and remain operational when Gateway and remote
Providers are unavailable.

H3 contracts explicitly identify candidate-only and exact-verification
requirements. H3 output cannot satisfy an exact-geometry DAG port. Exact
topology remains a Spatial/PostGIS responsibility.

## Consequences

- Adding a conforming Provider does not change Gateway core source.
- A caller cannot elevate DataScope through a JSON body.
- Operation versions coexist without schema ambiguity or duplicate `$id`
  registration.
- Schema, receipt, evidence, and snapshot drift fail closed at protocol
  boundaries.
- External Provider source and build output remain outside this repository; only
  bridges, contracts, locks, and integration evidence are committed.
- CRS and Geometry redistribution remains disabled until their project-level
  licensing is resolved; H3 and Spatial retain Apache-2.0 notice/SBOM evidence.
