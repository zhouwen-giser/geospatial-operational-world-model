# S03 Strict Turn-aware Routing Completion

## Phase / scope

S03 completes the v0.6 solver surface with a bounded deterministic state-space constructor. It carries Arc-history state through start access, full-network connectors, service transitions, later connectors, and terminal return. It never delegates sequence restrictions to an incomplete routing primitive.

## Strict legality and cost

- Pairwise `FORBIDDEN` transitions are removed from search; `ALLOWED_ONLY` rejects every non-listed successor after the governed Arc.
- Arbitrary multi-Arc forbidden sequences are matched against retained suffix history. A connector goal is accepted only if its next service/terminal Arc remains legal, preventing context loss at phase boundaries.
- Consecutive atomic intervals on the same authority Arc do not create fake turns.
- Profile-filtered rules, positive turn penalties, closure conditions, road class, surface, access mask, maximum speed, speed override, and risk override are applied before or during search.
- Speed override recomputes integer duration while preserving distance. Closed or profile-ineligible required Arcs fail `NO_FEASIBLE_PLAN` rather than being silently omitted.
- `SHORTEST_DISTANCE`, `FASTEST`, `LOWEST_RISK`, `LOWEST_ENERGY`, and `BALANCED` use fixed-point objective values. All segment and route sums are safe-integer checked.
- Time, matrix-cell, and candidate-beam budgets are enforced at search boundaries. Deterministic clock evidence proves the time limit; a one-cell matrix fails safely; a one-candidate beam remains bounded.
- `routeCount > 1` and `EITHER_DIRECTION` fail before graph search.

## Tests actually run

| gate | result | evidence |
|---|---|---|
| focused strict solver tests | PASS, 7 tests | pairwise/only/sequence, conditions/profile, three objectives, replay, budgets/overflow, negative modes |
| strict solver machine gate | PASS, 23 checks | `s03-strict-routing-s03-20260825t1140.json` |
| frozen route/diagnostics contracts | PASS | sequence-rule scenario |
| strict implementation scan | PASS | turn-state search present; no `pgr_trsp` invocation |
| strict build/typecheck | PASS | repository TypeScript and STAS |
| full repository Vitest regression | PASS, 216 tests | 42 files passed; one pre-existing optional test skipped |
| predecessor/source/boundary guards | PASS | exact v0.5 locks, reference-only policy, authority and Gateway boundaries |

The objective corpus has three material connector alternatives. Distance selects the direct Arc, time selects a two-Arc fast path, and risk selects a different two-Arc low-risk path. The sequence corpus rejects the cheapest connector because its retained two-Arc history would make the subsequent service Arc complete a forbidden three-Arc sequence.

## Acceptance IDs

`AC-S009..AC-S013` and `AC-S018..AC-S030` are PASS. Together with S00–S02, all `AC-S001..AC-S030` solver rows are now evidenced.

## Commit / push / PR

S03 is delivered as a semantic phase commit, pushed, and reflected in Draft PR #4.

## Blockers / next

No solver blocker. Proceed to V00 with an independently implemented verifier that imports no solver legality, turn, cost, or coverage helper.
