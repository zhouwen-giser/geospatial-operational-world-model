# GOWM Spatial Provider Bridge

This provider is a GOWM-owned adapter over the versioned
`gowm_spatial_v1` Foundation read contract. It does not run or copy the supplied
Spatial POC and it never reads Foundation base tables.

Every execution uses an independent read pool and a `REPEATABLE READ READ ONLY`
transaction. It sets transaction-local statement and lock timeouts, establishes
the trusted DataScope using `gowm_spatial_v1.set_data_scope`, and then executes
only static parameterized SQL against the four contract views. Input contains no
SQL, table, schema, connection, URL, or provider selector.

Object results expose only opaque ReferenceKey values plus freshness,
confidence, and provenance. Current-projection snapshots are honestly marked
`CONSISTENT_AT_START` with `AT_LEAST` resource pinning; the provider never
claims a historical pinned World Version. World-data results create Evidence
References in addition to the computation Receipt. Signed cursors bind the
operation, DataScope digest, sort semantics, and current dataset version.

Nearby/nearest location accepts the canonical object form or a canonical CRS
point position array `[longitude, latitude, z?]`; optional Z is ignored by the
2D query and recorded in the receipt warning. `find-in-area` and
`find-intersections` optionally accept at most 50,000 opaque candidate
ReferenceKeys. The candidate list is a JSONB parameter only; it narrows the
search but never replaces the exact `ST_Covers` or `ST_Intersects` predicate.

Readiness runs inside the same read-only transaction boundary, checks all four
contract views, and requires `postgis_lib_version()` to exactly match the
configured Compute Snapshot engine version. Failures return a generic
contract-unavailable reason rather than database details.

`spatial.join` and `spatial.aggregate` remain `EXPERIMENTAL`; the other eight
operations are `PREVIEW`.
