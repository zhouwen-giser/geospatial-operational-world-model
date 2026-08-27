# GOWM+ v0.6.3 Grounding Core and Consumer Contracts

Status: stable-candidate contract freeze, 2026-08-27.

## Authority boundary

GOWM remains the source of truth for Gateway contracts. The generated
`@gowm/world-gateway-contracts@0.6.3` workspace package is a deterministic
consumer distribution, not an independently editable contract authority. It
contains no Provider URL, transport credential, database name, container name,
runtime log, or deployment registry.

The only maturity changes are `reference.get`, `reference.resolve`,
`world.get-current-state`, `world.get-geometry`, `world.get-provenance`,
`catalog.get`, `catalog.search`, `spatial.find-nearby`,
`spatial.find-in-area`, and `spatial.find-intersections`, all at version 1.0.

## Delegated identity

`STATIC_SERVICE` remains the default and preserves the v0.6.2 bearer contract.
`SIGNED_DELEGATION_V1` additionally verifies an RS256 compact JWS, fixed issuer
and audience, authenticated service subject, request binding, a maximum 300
second lifetime, current time window, and `delegationDepth = 1`. Effective data
scopes, dataset scopes, and exact `operationId@version` permissions are
intersections with the service policy. Raw delegation material is neither
forwarded nor persisted; audit and idempotency use stable hashes of the service,
actor, scopes, and allowed-operation set.

## Query snapshot semantics

Snapshots are logical resource-version manifests, never exported PostgreSQL
MVCC snapshots. `LATEST_AT_START`, `PINNED`, `AT_LEAST_WORLD_VERSION`, and
`BEST_EFFORT` are resolved before a query job is stored. The immutable manifest
is reused after restart and on idempotent replay, sent to every Provider as
`requestedSnapshot`, and compared with returned `dataSnapshot` evidence.
Strict policies fail closed on unsupported or mismatched snapshots;
best-effort execution returns explicit adherence and warnings.

## Operation availability

Authenticated endpoints expose per-operation `AVAILABLE`, `DEGRADED`,
`UNAVAILABLE`, or `DISABLED` state with controlled reason codes. Results are
filtered by the caller's operation permissions and cached for no more than five
seconds. Provider identity, endpoint, container, and database topology remain
private. Availability is advisory; execution rechecks registry, maturity,
delegated permission, circuit, and Provider readiness.
