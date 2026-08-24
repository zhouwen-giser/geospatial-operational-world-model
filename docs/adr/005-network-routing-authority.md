# ADR 005: Network graph and basic route-planning authority

Status: Accepted

## Context

GOWM+ already owns versioned datasets, layers, features, opaque ReferenceKeys, capability execution, and derived results. Network routing adds topology and computation, but it must not create a second road truth in a Provider, confuse a planned route with physical execution, or allow orchestration code to become a routing engine.

## Decision

- The GOWM+ Data Foundation is the sole authority for NetworkGraphVersion, Node, Edge, Arc, turn restrictions, travel/cost profile versions, condition snapshots, build receipts, diagnostics, validation, and activation history.
- Source road identity remains a versioned Dataset/Layer/Feature with an opaque `LAYER_FEATURE` ReferenceKey. Node, Edge, and Arc keys are stable only inside one immutable GraphVersion and are not promoted to WorldObjects.
- The protected Network Build Worker is the only normal writer for graph versions. Build, validate, and activate operations are management-plane commands and are never registered as ordinary public capabilities or exposed by read-only MCP.
- Network and Route Planning Providers use separate service identities and do not call each other. Both may import a pure, side-effect-free network query core, and both read only the scope-filtered `gowm_network_v1` contract.
- Provider database roles cannot select or mutate Network Foundation base tables. The builder cannot write Provider route results. The Route Provider writes only its request/run/candidate/result store and existing Derived Result integration.
- A GraphVersion and each travel/cost profile version are append-only and immutable. Dynamic closure, speed, risk, access, and multiplier facts create a new ConditionSnapshot rather than modifying Arc rows.
- Every network or route computation pins a complete RoutingSnapshot: dataset version, graph version/hash, travel profile version/hash, cost profile version/hash, condition snapshot/hash, and optional WorldVersion.
- Fixed-point integer fields are authoritative internally: millimetres, milliseconds, risk micro-units, milli-watt-hours, and combined cost units. Floating-point conversion is presentation-only at an API boundary.
- Directed point snapping returns candidate Arc states with a fraction and evidence. Ambiguous candidates remain explicit. Route endpoint candidates are evaluated jointly.
- Pairwise and multi-edge turn restrictions apply through every waypoint leg. Multi-edge restrictions use a product-state/sequence automaton. pgRouting supplies bounded graph primitives only and is not the semantic authority for turn sequences, snapshots, scope, or result identity.
- The independent Route Verifier replays identity, continuity, direction, turns, partial fractions, via/avoid constraints, profiles, conditions, and fixed-point metrics without importing Solver legality or cost-accumulation helpers.
- A Route Plan is a `QUERY_RESULT`/DerivedReference with `revalidationRequired=true`. `FEASIBLE` means computationally feasible under the pinned inputs; it never means dispatched, physically executable, observed, completed, or verified in reality.
- The Gateway validates schemas, scope, budgets, DAG types, idempotency, jobs, cancellation, replay, and result registration. It contains no pgRouting SQL, topology compiler, snapper, turn automaton, shortest-path implementation, or route verifier.
- DataScope is authoritative at three layers: trusted Gateway context, Provider transaction setup, and SQL read-contract filtering before match, rank, count, timing-sensitive work, or pagination.

## Ownership matrix

| Artifact | Authority | Writer | Readers |
|---|---|---|---|
| Dataset/Layer/Feature and source ReferenceKey | GOWM Catalog | existing catalog paths | builder and existing catalog/read contracts |
| GraphVersion/Node/Edge/Arc/Turn/Profile/Condition | Network Foundation | protected builder/condition ingestion | `gowm_network_v1` only for Providers |
| Route request/run/candidate/result/verification | Route Provider Derived Store | Route Provider worker | Route Provider and Derived Result registration |
| Gateway job/DAG/idempotency/result link | Gateway | Gateway | authorized Gateway clients |
| Route Plan physical truth | none | none | explicitly a non-claim |

## Consequences

There is one auditable graph lineage from a pinned NETWORK DatasetVersion. Active-pointer changes never alter a pinned historical route. A condition change can make an older result `STALE` but cannot rewrite it. Provider failure cannot mutate graph truth, and Gateway failure cannot change routing semantics. Coverage routing, multi-vehicle optimization, OR-Tools, device dispatch, WSGS, SACS, SDAR, SMPP, and A2A remain outside v0.5.

Exact Avoid Area evaluation is exposed only as the scoped `gowm_network_v1.arcs_intersecting_areas` security-definer read function. Route roles do not receive general Public/PostGIS execution or Network base-table privileges. Coordinate snapping uses the request's bounded `snapToleranceM` and otherwise defaults to 100 metres so distant candidates cannot create zero-length route shortcuts.
