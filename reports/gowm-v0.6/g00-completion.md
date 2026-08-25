# G00 Gateway, DAG, Result Registry, and Expansion Completion

## Phase / scope

G00 connects the production road-coverage engine to the existing World Capability Gateway. The Gateway remains the only public job authority; the Coverage runtime stores only an internal request/run linked to the trusted Gateway job UUID. No second northbound lifecycle or Network/Route Provider client is introduced.

## Runtime and persistence

- Trusted Gateway job/query/node identities are added to the internal Provider execution request and are populated only by `DirectExecutionService` from a claimed Gateway job. Direct calls to the async plan operation without this context fail closed.
- The production engine reuses the pinned Network repository, PostGIS selection and endpoint contracts, strict solver, independent verifier, alternative selector, and durable Coverage repository.
- The real `world.get-geometry -> coverage.road.validate -> coverage.road.plan` DAG is submitted over the Gateway HTTP API, claimed from PostgreSQL, and executed in typed dependency order.
- Result sets are registered as `QUERY_RESULT/ROAD_COVERAGE_PLAN_SET`; selected alternatives are registered as `DERIVED_REFERENCE/ROAD_COVERAGE_ALTERNATIVE` in the same publication transaction.
- Candidate routes, ordered segments, obligation traversals, verification reports, and pairwise similarity are persisted before publication. The main result contains no duplicated geometry.
- `coverage.road.expand-geojson` resolves ordered segment geometry from the pinned graph on demand and carries the corresponding Data Snapshot in the Provider envelope.
- Completed Gateway queries replay across runtime recreation. Expired results revalidate as `STALE/RESULT_EXPIRED`, and expired geometry expansion is denied.

## Tests actually run

| gate | result | evidence |
|---|---|---|
| real Gateway/Provider/PostgreSQL E2E | PASS, 21 checks | `g00-runtime-g00-runtime-20260825t1915.json` |
| fresh plus exact-v0.5 upgrade schema gate | PASS, 52 migrations / 37 assertions | `d00-runtime-g00-db-20260825t1930.json` |
| B00 PostGIS selection regression | PASS, 14 checks | `b00-runtime-g00-select-20260825t1945.json` |
| J00 async lifecycle regression | PASS, 15 checks | `j00-runtime-g00-async-20260825t2000.json` |
| Provider protocol regression | PASS, 13 checks / 5 operations | `p00-provider-g00-provider-20260825t2015.json` |
| full repository Vitest regression | PASS, 237 tests | 46 files passed; one pre-existing optional file/test skipped |
| SQL AST | PASS | migrations 001..052 and assertions 001..037 |
| strict build/typecheck | PASS | root TypeScript and STAS |
| architecture and source-policy gates | PASS | road-coverage boundaries and locked-source policy |

The successful E2E persisted one query result, two derived alternative references, two candidates, seven ordered route segments, two independent verification reports, and one pairwise-similarity row, then dropped its isolated database.

## Acceptance IDs

`AC-J001..AC-J003` and `AC-P003..AC-P011` are PASS. The earlier P00 contract rows remain PASS. `AC-P015` and `AC-P016` remain `NOT_RUN` until T00 deliberately exercises node/provider error identity and Coverage-provider outage isolation.

## Authority / scope review

The Provider receives data and dataset scope only from the authenticated Gateway principal. Artifact reads and expansion require the same scope keys. The Coverage schema grants only controlled functions to `coverage_planner_provider`; publication trigger execution is revoked from `PUBLIC`. The engine imports repository code, not Provider HTTP clients, so Network and Route authorities remain unchanged.

## Failed attempts

Failed evidence is retained for runs `t1620` through `t1900`. Those runs exposed and fixed, in order: Windows nested npm launch, output-port shape, aggregate DAG budgets, missing controlled output path, absent controlled Provider registry rows, SQL JSON operator precedence during publication, and a missing Data Snapshot on the data-bound expansion result. Every isolated database cleanup passed; none of these runs is counted as acceptance evidence.

## Commit / push / PR

G00 will be delivered as a semantic phase commit, pushed to `codex/gowm-road-coverage-v0.6`, and reflected in Draft PR #4.

## Blockers / next

No G00 blocker. Proceed to T00 scope/security/performance/recovery, retaining `AC-P015` and `AC-P016` as open rows.
