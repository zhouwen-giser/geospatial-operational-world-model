# ADR 006: Road coverage planning authority and stable v0.6 boundary

Status: Accepted

## Context

GOWM+ v0.5 already owns one immutable, directed, scope-filtered Network Foundation and a basic route-planning capability. Road coverage planning adds service obligations, postman/RPP solving, independent verification, alternatives, and asynchronous result publication. It must not copy network truth, turn the Gateway into a solver, or describe a computational plan as physical operational truth.

## Decision

- `V0_5_NETWORK_AUTHORITY`: the v0.5 GraphVersion, Node, Edge, Directed Arc, turn restrictions, travel/cost profiles, condition snapshots, and RoutingSnapshot remain the only network authority.
- `NO_SECOND_GRAPH`: Coverage persistence contains no graph-version, road-arc, turn-transition, or turn-sequence authority table. Coverage rows pin foreign network identities and immutable hashes only.
- Coverage reads only the scope-filtered `gowm_network_v1` contract or a pure, side-effect-free network-query-core API over the same contract.
- `NO_PROVIDER_TO_PROVIDER_HTTP`: `gowm.road-coverage-planning` has no Network Provider or Route Planning Provider HTTP client. It may share pure network query primitives; it cannot call a sibling Provider.
- The complete traversable directed arc set E and the required service-obligation set R are separate types and stores. E permits access/transit/connection; only R creates service debt and coverage credit.
- A service obligation identifies an Arc and exact bounded integer fractions. `FIXED_DIRECTION` creates one fixed directed obligation. `BOTH_DIRECTIONS` expands deterministically to two fixed directed obligations. `EITHER_DIRECTION` is unsupported and fails closed.
- Stable v0.6 fixes `routeCount` to one. Fleet, capacity, time windows, CARP, OR-Tools, clustering, depot assignment, dispatch, multi-route repair, and multi-vehicle optimization fail closed as unsupported.
- Stable solver families are Closed DCPP, Open DCPP, fixed-direction RPP, and both-directions-required RPP. Boundary and endpoint policy never relaxes snapshot, direction, continuity, turn, profile, condition, or scope constraints.
- Fixed-point bounded integers are authoritative for fractions, distance, time, risk, energy, combined cost, counts, and budgets. Floating-point values are presentation-only GeoJSON projections.
- The Coverage Solver may use pure network-query-core but owns only problem construction, obligation ledgers, terminal policy, candidate search, and solver receipts.
- The independent Coverage Verifier uses its own continuity, turn-state replay, fractional coverage, terminal/boundary, fixed-point metric, scope, and snapshot logic. Build tooling forbids imports from solver legality, metric, obligation-ledger, or route-construction modules.
- The Gateway validates schemas, trusted scope, budgets, idempotency, generic Job/DAG state, cancellation, replay, and result registration. It contains no DCPP, RPP, matching, obligation-ledger, terminal-policy, or verifier algorithm.
- Successful plan sets register as `QUERY_RESULT/ROAD_COVERAGE_PLAN_SET`. Alternatives register as `DERIVED_REFERENCE/ROAD_COVERAGE_ALTERNATIVE`; an optional ReferenceSet may group them. Every successful result requires revalidation and has a bounded TTL.
- `FEASIBLE_VERIFIED` means only that an independent verifier found the route feasible under the exact pinned immutable inputs. It is not dispatchable, physically ready, observed, executed, completed, safe for a device, or verified in Operational Reality.

## Ownership matrix

| Artifact | Authority | Writer | Reader |
|---|---|---|---|
| Dataset/Layer/Feature and Area ReferenceKey | existing Catalog | existing Catalog writers | Gateway and scoped resolution paths |
| GraphVersion/Node/Edge/Arc/Turn/Profile/Condition/RoutingSnapshot | v0.5 Network Foundation | protected v0.5 writers | `gowm_network_v1` / pure network-query-core |
| Area-selection receipt and service obligations | Coverage Planner derived store | Coverage Provider worker | Coverage Solver and independent Verifier |
| Canonical coverage problem and solver receipt | Coverage Planner derived store | Coverage Provider worker | Solver, Verifier, result publisher |
| Alternative, segment, ledger, verification | Coverage Planner derived store | generation-fenced worker | authorized result paths |
| Gateway Job/DAG/idempotency/result link | Gateway | Gateway | authorized Gateway clients |
| Physical dispatch/execution truth | none in v0.6 | none | explicit non-claim |

## Consequences

Every result is reproducible from an immutable network snapshot, canonical problem, obligation ledger, solver version, and independent verification report. Network activation or condition changes can make a result stale but cannot rewrite it. Solver failure cannot mutate network truth, and Gateway failure cannot change solver semantics.

The v0.7 extension points are versioned rather than silently accepted: a future operation version may add fleet or multi-route semantics, while v1 remains stable and rejects those fields.
