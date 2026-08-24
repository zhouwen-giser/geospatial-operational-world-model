# G06 World Evidence Provider

## Decision

`PASS`

The canonical `gowm.world-evidence` Provider now exposes all nine frozen
operations: current state, geometry, provenance, observations, event timeline,
state history, result lookup/validation, and reference-set paging. The Result
Registry operations are deliberately owned by this canonical Provider rather
than a non-contract `gowm.result-registry` identity.

Migration 023 adds scope-filtered, versioned evidence views and a dedicated
least-privilege service login. Provider reads occur only through
`gowm_evidence_v1` and `gowm_result_v1`, inside repeatable-read/read-only
transactions. Observation and event timelines use separate stable keyset
orders and HMAC-signed cursors bound to the operation, DataScope, and complete
evidence snapshot. World events are append-only except for publication status.

Current Projection, immutable Observation, and WorldEvent records remain
distinct. A missing projection returns `NO_DATA` with empty facts/evidence and
an explicit unknown marker; it never fabricates a negative world fact.

## Real verification

- PostgreSQL 18/PostGIS: the service role can select versioned evidence/result
  views and cannot select WorldObject, Observation, or WorldEvent base tables;
  both read contracts are DataScope-isolated.
- Late evidence fixture: `ugv-001` keeps current projection version 11 and
  status `AVAILABLE`, while a delayed observation and its separately stored
  event remain queryable at event world version 64.
- Live authenticated Provider HTTP: the canonical manifest exposes all nine
  operation/schema hashes; current state includes version, freshness,
  confidence, source observation, provenance, and uncertainty; geometry
  includes GeoJSON, `EPSG:4326`, and version; all three histories advance over
  signed pages; Result Registry operations are available under the canonical
  Provider; cross-scope result lookup is `SCOPE_DENIED`.
- `NO_DATA` fixture: an authorized ReferenceKey without a WorldObject projection
  returns no facts or evidence and `CURRENT_STATE_UNAVAILABLE` as an unknown.
- Fresh database: migrations 001–023 and all twelve SQL assertion files pass.
- Full repository verification: typecheck, SQL AST validation, root/STAS tests,
  and builds pass.

## Acceptance coverage

AC-G039–G045 are covered at the real database and Provider boundary. The
cross-Provider Reference-to-Evidence DAG and final `GROUNDING_READY` gate remain
for G08; replay/security hardening continues in G07.

The C02 locked-Provider blocker remains unchanged.
