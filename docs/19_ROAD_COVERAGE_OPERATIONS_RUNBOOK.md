# Road Coverage Planning v0.6 operations and recovery runbook

## Stable operating boundary

`gowm.road-coverage-planning` computes one verified route over an immutable,
scope-bound RoutingSnapshot. It reads the single `gowm_network_v1` authority and
writes only derived Coverage problems, candidates, verification, and results.
The Gateway owns public jobs, scope, budgets, cancellation, DAG orchestration,
and result registration. The Provider does not call Network or Route Providers.

Stable operations are `coverage.road.validate`,
`coverage.road.select-obligations`, `coverage.road.plan`,
`coverage.road.verify`, and `coverage.road.expand-geojson`. Plan is asynchronous
through the existing Gateway job model; the other operations are synchronous.

## Required configuration and fail-closed controls

- Use separate database principals: `gowm_gateway_runtime`,
  `coverage_planner_provider`, `network_provider`, and `route_planner_provider`.
- Only the Gateway supplies authenticated DataScope/DatasetScope and trusted job,
  query, node, registry, and policy identity. Request fields cannot select a SQL
  relation, database URL, Provider URL, or dynamic code path.
- Keep resource caps enabled: 50,000 area vertices, 100,000 obligations,
  100,000 connector matrix cells, 64 generation candidates, and 1,000,000 route
  segments, plus Gateway output/deadline budgets.
- A successful result always pins the full RoutingSnapshot, has bounded TTL, and
  sets `revalidationRequired=true`. Never reinterpret it as dispatchable.

## Verification

From a clean candidate checkout, run:

```text
npm ci
npm run check
npm run verify:sql
npm test
npm run validate:gowm-v06-boundaries
npm run validate:gowm-v06-source-policy
```

The database gates require the exact validated composite image and explicit
opt-in environment variables. Use a unique lowercase run ID. T00 creates and
removes its own dedicated PostgreSQL container. The schema gate creates only
derived `gowm_v06_fresh_*`, `gowm_v06_v04_*`, and `gowm_v06_upgrade_*`
databases inside the explicitly named container and removes them afterward.
Do not point these gates at production.

Successful authoritative evidence for this candidate is:

- `reports/gowm-v0.6/t00-runtime-t00-runtime-20260826t0030.json`
- `reports/gowm-v0.6/d00-runtime-c00-matrix-20260826t0100.json`
- `reports/gowm-v0.6/c00-runtime-c00-runtime-20260826t0115.json`

## Recovery and cancellation

After PostgreSQL or worker restart, wait for database health before resuming
claims. Gateway query submission with the same principal/idempotency key must
replay the persisted terminal result. Confirm one Gateway job, one Coverage
request, and one result; confirm the result remains in-scope and unexpired.

Lease expiry may requeue only a nonterminal generation. A new claim increments
generation; old heartbeat/problem/candidate/result writes must fail. Cancellation
is terminal at Coverage request/run level. Exercise SOLVING, VERIFYING, and
PUBLISHING fencing and verify zero result rows before declaring recovery.

Provider outage is isolated: fail the Coverage operation with its typed Provider
identity while Network and Route operations remain available. Do not introduce a
sibling-Provider HTTP fallback. A stale/expired Network snapshot or Coverage
result is revalidated as stale and is never silently rewritten.

## Observability and incident evidence

Record hashes, counts, versions, low-cardinality stage names, elapsed time, and
bounded resource units for Obligation Selection, Endpoint Resolution, Connector
Matrix, Solver, independent Verifier, Result Persist, and GeoJSON Expand. Do not
log full geometry, tokens, sensitive metadata, raw SQL, connection strings, or
unredacted Provider errors. Preserve failed gate evidence separately from PASS;
never use a failed run as acceptance evidence.

## Explicit non-claims

Stable v0.6 does not implement `EITHER_DIRECTION`, `routeCount > 1`, fleet or
multi-vehicle assignment, capacity, time windows, CARP, OR-Tools, dispatch,
device control, execution reporting, or physical completion. Small/Medium gate
timings are local acceptance-fixture regression evidence, not production SLO,
capacity, HA, backup/PITR, or operating-area certification.
