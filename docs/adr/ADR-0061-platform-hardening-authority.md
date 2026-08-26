# ADR-0061: Platform hardening authority and current contract

Status: Accepted for v0.6.1 implementation.

GOWM Data Foundation remains the only authority for facts, datasets, versions,
lineage, and references. The Capability Registry remains the only operation
registry. Capability semantics and Data Product descriptors are deterministic,
read-only projections of those existing authorities.

Network, Route, and Coverage Providers consume `gowm_network_v1` through the
independent `network-query-core` package. Providers neither import sibling
Provider implementations nor call one another over HTTP. Gateway code may
project registry metadata and dispatch operations, but may not implement GIS,
routing, coverage, catalog, or currentness algorithms.

Coverage candidate `boundaryEvents` are non-authoritative hints. Verification
reconstructs crossings from pinned route segments and versioned geometries.
Frozen plan validity is reported separately from current snapshot currentness;
TTL expiry is a third independent dimension.

The user confirmed there is no old data and removed old wire/data compatibility
from acceptance. Each operation has one current contract and owner.
`reference.validate` and `result.validate` belong only to Platform Validation
and share the current batch contract. World Evidence `result.get` exposes the
eight normalized statuses and retains source status/authority explicitly.
No obsolete validation route or synthetic legacy compute manifest is retained
in the current public execution path. Migrations 001–053 stay immutable;
changes are append-only through 058.

Platform Validation reads scoped authoritative views in a read-only repeatable
read transaction. Currentness is determined from actual graph, dataset,
travel/cost profile, condition and world versions, never from a echoed request
version. Reference retirement and expiry are separate from source execution
status and frozen computational validity. Result visibility includes the
source Gateway job's dataset scope, including same-DataScope sibling datasets.

Conformance inspects executable manifests and exact known schema hashes,
co-registers the current providers and labels contract/unit evidence as such.
The real Docker gates use PostgreSQL-backed providers and capture the source
fingerprint before and after execution. Compatibility rows AC-R012 and AC-S-03
remain traceable as SUPERSEDED_BY_USER, not PASS.

The implementation does not build or validate WSGS, SACS, SDAR, A2A, a separate
Data Platform Readiness gate, or mock ELEVATION onboarding.
