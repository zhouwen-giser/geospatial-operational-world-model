# ADR-001: GOWM+ foundation with STAS as a separate application process

- Status: Accepted
- Date: 2026-08-13

## Context

Both supplied packages contain mature but overlapping time/space data models.
Installing them side by side would create two authorities for observations and
tracklets and make evidence replay ambiguous.

## Decision

Use one PostgreSQL instance and database with logical ownership boundaries.
Retain the GOWM+ v1.2 schema and services as the canonical foundation. Run STAS
as an independently deployable process under `services/stas`; it reads only
versioned GOWM-to-STAS contracts and appends its own analysis records. HTTP and
OpenAPI are authoritative; MCP/A2A integration remains an optional thin edge.

Do not install standalone STAS fact or builder migrations. Reuse its validated
tool algorithms and contracts through an adapter. Keep existing GOWM schema
names where a wholesale schema move would add upgrade risk; enforce separation
with roles, grants, immutable triggers, versioned views, and tests.

All services use UTC and API ranges have explicit `[start,end)` semantics.

## Consequences

- There is one Observation/Measurement/Tracklet authority and one evidence
  replay path.
- STAS tool SQL must target stable contract views, not GOWM implementation
  tables.
- Missing sensor/coverage contracts are foundation work, not private STAS data.
- Candidate discovery remains coarse/filter/cap+1/freeze/exact/stable-order.
- A later schema split or separate database uses immutable outbox/CDC contracts,
  never blind dual writes.
