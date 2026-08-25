# ADR-0061: Platform hardening authority and compatibility

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

The v0.6.1 wire strategy is additive. Existing v1.0 operation schemas remain
unchanged. New common contracts and endpoints use version 1.0 within the new
v0.6.1 namespace; optional Coverage fields may be added only where old clients
continue to validate. Migrations 001–053 are immutable, and all changes are
append-only from 054.

The implementation does not build or validate WSGS, SACS, SDAR, A2A, a separate
Data Platform Readiness gate, or mock ELEVATION onboarding.
