# S02 Fixed-direction and Both-directions RPP Completion

## Phase / scope

S02 implements a deterministic bounded Fixed-direction Rural Postman solver while preserving the core invariant `R != E`: canonical obligations alone define service, and the complete pinned traversable network is used for connection and balance.

## RPP construction

- Every authority Arc in `E` is split only in solver-local state at obligation and terminal fractions; no Network Foundation Arc or node is created or mutated.
- Each fixed-direction obligation creates the exact required interval and exact required-pass multiplicity.
- Weakly disconnected required components and terminal states form the connection problem.
- Directed shortest paths over complete atomic `E` produce a deterministic minimum spanning component tree, bounded by `maximumMatrixCells` and the problem deadline.
- The connected multigraph's residual degree vector is repaired by exact minimum-cost flow before deterministic Euler construction.
- Atomic connector intervals contained in an obligation are `DUPLICATE_SERVICE` and carry its ID. All other connector intervals are `TRANSIT` with no service claim.
- Same-edge opposite directed Arc obligations select the `BOTH_DIRECTIONS_RPP` algorithm family; both directions remain distinct fixed obligations.
- Partial service segments retain their exact integer start/end fraction. Fixed-point slices and totals fail closed on unsafe integers.

## Tests actually run

| gate | result | evidence |
|---|---|---|
| focused Fixed/Both RPP tests | PASS, 4 tests | partial service, disconnected components, repeated/both directions, deterministic replay |
| machine RPP gate | PASS, 11 checks across 3 scenarios | `s02-fixed-rpp-s02-20260825t1120.json` |
| frozen route/diagnostics contracts | PASS | all three machine scenarios |
| strict build/typecheck | PASS | repository TypeScript and STAS |
| full repository Vitest regression | PASS, 209 tests | 41 files passed; one pre-existing optional test skipped |
| predecessor/source/boundary guards | PASS | exact v0.5 locks, reference-only policy, authority boundaries |

The disconnected scenario services only `A -> B` and `C -> D`; `B -> C` and `D -> A` remain transit. The partial scenario services only 250000–750000 ppm and uses three non-service atomic intervals to return. The both-direction scenario proves two required forward passes, one required reverse pass, and one reverse balance copy classified `DUPLICATE_SERVICE`.

## Acceptance IDs

`AC-S006..AC-S008` and `AC-S014..AC-S017` are PASS. Turn legality and conditions/objectives/resource guards remain assigned to S03.

## Commit / push / PR

S02 is delivered as a semantic phase commit, pushed, and reflected in Draft PR #4.

## Blockers / next

No S02 blocker. Proceed to S03 strict pairwise and multi-edge turn-aware routing, profile/condition legality, objective metrics, and negative/resource guards.
