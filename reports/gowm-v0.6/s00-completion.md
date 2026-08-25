# S00 Closed Directed CPP Completion

## Phase / scope

S00 implements an exact single-route Closed Directed Chinese Postman solver for the stable subset where every traversable Arc in `E` is represented by one full-Arc fixed-direction service obligation in `R`. Partial service, required-subset RPP, open terminals, and strict turn automata remain fail-closed for their assigned phases.

## Solver construction

- The canonical Coverage Problem and pinned graph version are validated before solving.
- Full traversable Arc records retain direction, graph endpoints, source evidence, and non-negative safe-integer fixed metrics.
- Required pass multiplicity creates the directed service multigraph and its exact node imbalance vector.
- Connector costs are shortest paths over the complete supplied traversable network, bounded by `maximumMatrixCells` and the problem deadline.
- A residual-network minimum-cost transportation solve assigns all deficit-to-surplus flow exactly; it is not a greedy pairing.
- Deterministic Hierholzer traversal consumes every required and augmented Arc instance exactly once.
- An exact start inside an Arc is represented by that Arc's suffix at route start and prefix at route end. The returned terminal is byte-equivalent to the supplied directed state; no synthetic global Arc or node is created.
- Augmentation traversals on required Arcs are classified `DUPLICATE_SERVICE`; original required passes remain `SERVICE`.
- Fraction metrics are partitioned with integer arithmetic and route totals use overflow-checked safe-integer sums.

## Tests actually run

| gate | result | evidence |
|---|---|---|
| focused Closed DCPP tests | PASS, 4 tests | balanced Euler circuit, minimum-cost imbalance repair, deterministic exact terminal, partial-RPP fail-closed |
| machine Closed DCPP gate | PASS, 6 checks | `s00-closed-dcpp-s00-20260825t1055.json` |
| generated contract validation | PASS | Coverage Route and Solver Diagnostics |
| strict repository check/build | PASS | generated contracts, TypeScript, STAS |
| full repository Vitest regression | PASS, 201 tests | 39 files passed; one pre-existing optional test skipped |
| predecessor/source/boundary guards | PASS | exact v0.5 locks, reference-only policy, authority boundaries |

The imbalanced fixture compares a direct connector costing 10 with a legal two-Arc connector costing 2. The exact solver selects the latter, creates two duplicate traversal instances, builds a nine-segment route, and deterministically replays the same route signature.

## Acceptance IDs

`AC-S001..AC-S003` are PASS. `AC-S004..AC-S030` remain assigned to S01–S03 and are not claimed by this phase.

## Commit / push / PR

S00 is delivered as a semantic phase commit, pushed, and reflected in Draft PR #4.

## Blockers / next

No S00 blocker. Proceed to S01 Open Directed CPP with exact distinct terminal imbalance.
