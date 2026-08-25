# E00 Endpoint and Boundary Policy Completion

## Phase / scope

E00 resolves request start/fixed-end locations and entry/exit policies against the pinned Network read contract. Coordinate, Layer Feature ReferenceKey, and exact DirectedNetworkState inputs converge to bounded directed Arc states with evidence; no partial endpoint creates or mutates a global Arc.

## Endpoint and crossing semantics

- Equal-score parallel-road snaps return `AMBIGUOUS_LOCATION`; no arbitrary first row is accepted.
- Supplied directed states retain Arc, integer fraction, direction, heading/source evidence and must exist in the pinned graph/scope.
- AUTO candidates derive from actual PostGIS boundary clips, deduplicate, sort, and enforce configured bounds.
- CANDIDATE_SET validates and restricts the search to supplied states. FIXED requires exactly one valid state.
- RETURN_TO_START, FIXED_END, and LAST_AREA_EXIT compare exact directed terminal states.
- FREE, FIRST_ENTRY_ONLY, ENTRY_SET_ONLY, and NO_REENTRY are evaluated over ordered boundary events without solver shortcuts.

## Tests actually run

| gate | result | evidence |
|---|---|---|
| focused endpoint policy tests | PASS, 10 groups | ambiguity, partial state, candidate modes, terminals, four crossing policies |
| real PostgreSQL/PostGIS endpoint gate | PASS, 13 checks | `e00-runtime-e00-20260825t1020.json` |
| strict build/check | PASS | generated contracts and TypeScript |

The real gate runs as `coverage_planner_provider` over migrations 001–050, proves two deterministic entry and two exit candidates for the fixture area, verifies one-way ReferenceKey resolution, rejects foreign scope and unknown Arc state, and removes its isolated database.

## Acceptance IDs

`AC-E001..AC-E014` are PASS with focused policy tests plus real Network read-contract execution. Solver-phase route construction remains unclaimed.

## Commit / push / PR

E00 is delivered as a semantic phase commit, pushed, and reflected in Draft PR #4.

## Blockers / next

No E00 blocker. Proceed to S00 Closed Directed Chinese Postman construction and exact directed terminal closure.
