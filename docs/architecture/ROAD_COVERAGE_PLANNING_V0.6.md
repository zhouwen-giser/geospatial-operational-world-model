# Road Coverage Planning v0.6 architecture

## Processing boundary

```text
Dataset / Layer / Feature / Area Reference
  -> v0.5 GraphVersion + RoutingSnapshot authority
  -> gowm_network_v1 or pure network-query-core
  -> area selector -> immutable service obligations R
  -> canonical single-route problem over traversable arcs E
  -> DCPP/RPP solver -> candidate pool
  -> independent verifier
  -> QUERY_RESULT plan set + DERIVED_REFERENCE alternatives
```

R is not E. Required obligations carry exact service fractions and pass counts; traversable directed arcs provide legal access, transit, and connection paths. The planner may duplicate or deadhead over E without inventing coverage credit, and it may never erase an R obligation to obtain feasibility.

## Runtime components

- `road-coverage-core`: canonical types, area/obligation selection, problem hashing, endpoint and boundary policy, solver primitives, candidate diversity, and ranking.
- `road-coverage-verifier`: independent replay over frozen inputs; it cannot import solver legality, ledger accumulation, path construction, or solver metric helpers.
- `gowm.road-coverage-planning`: scoped protocol adapter, validation, async worker lifecycle, immutable publication, and GeoJSON expansion.
- Gateway: generic schema/scope/budget/Job/DAG/result-registry orchestration only.
- `coverage_planner`: private append-only derived persistence with controlled functions; it is not a network schema.

## Stable protocol

Provider operations are `coverage.road.validate`, `coverage.road.select-obligations`, `coverage.road.plan`, `coverage.road.verify`, and `coverage.road.expand-geojson`. Stable requests fix `routeCount=1`, accept only fixed/both-direction service modes, and reject v0.7 fleet/multi-route fields as typed unsupported errors.

All computation pins scope, Dataset/Graph/Profile/Condition snapshots, exact hashes, budgets, problem/solver/verifier versions, and receipts. Successful results always set `revalidationRequired=true` and never expose a `dispatchable` claim.

## Enforced markers

- `V0_5_NETWORK_AUTHORITY`
- `NO_SECOND_GRAPH`
- `NO_PROVIDER_TO_PROVIDER_HTTP`
- `INDEPENDENT_COVERAGE_VERIFIER`
- `SINGLE_ROUTE_V0_6`
- `COMPUTATIONAL_PLAN_NOT_PHYSICAL_FACT`
