# ADR 003: Grounding and Operational Reality authority

Status: Accepted

## Context

GOWM v0.3 must expose durable references, versioned spatial catalogs, derived
results, and world evidence without changing the identity or ownership model
established by the Foundation. v0.4 adds operational events, projections,
correlation, predicates, and observability without turning Provider execution
into asserted physical truth.

## Decision

- `world_reference_identity` remains the sole opaque, immutable identity root.
  New entity kinds are added by append-only migrations; names, descriptors,
  versions, retirement, and search terms live in separate append-only models.
- DataScope and DatasetScope are transport-derived authorization context.
  Candidate filtering occurs before ranking, counts, cursors, and timing-sensitive
  work. Providers read versioned SQL contracts and receive no Foundation write
  privilege.
- Dataset, Layer, and Feature identities are distinct from storage UUIDs and
  from existing SpatialObject facts. Bindings reference existing facts instead
  of copying them.
- Query results, derived references, and reference sets carry expiry,
  revalidation, input identity, DataSnapshot, and ComputeSnapshot evidence.
- Operational tasks are event-sourced. Control state, activity state, outcome
  verification, and observability are separate dimensions; no dimension is
  inferred from another.
- External correlation produces append-only claims and findings. Explicit
  identifiers outrank bounded derived matching; conflicts and non-matches are
  retained as evidence.
- Predicate outcomes preserve `NO_DATA`, `INDETERMINATE`, `NOT_SUPPORTED`, and
  `CONFLICTING` as distinct results. Provider `COMPLETED` never means the
  physical predicate or operational outcome is verified.
- Gateway remains a registry, policy, routing, idempotency, and DAG orchestration
  boundary. Domain truth and projection logic stay in Foundation-owned stores
  and read-only Providers.

## Consequences

All new database changes follow migrations 001–016. Existing migrations and
ReferenceKeys are checksum-stable. Rebuildable projections may be replaced,
but source events, identity, versions, evidence, claims, findings, and receipts
are append-only. WSGS, SACS, SDAR, and SMPP remain outside this repository and
are not modified or impersonated.
