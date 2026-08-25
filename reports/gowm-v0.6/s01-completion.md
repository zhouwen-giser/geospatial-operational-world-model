# S01 Open Directed CPP Completion

## Phase / scope

S01 extends the exact directed postman construction to `FIXED_END`. It solves the required open-trail balance target directly: the internal start has final `out - in = +1`, the internal end has `out - in = -1`, and every other node is balanced.

## Terminal construction

- Full-Arc obligations and all traversable Arcs remain snapshot/version checked before solving.
- The minimum-cost transportation input is the residual between the required multigraph balance and the requested open terminal balance.
- Distinct node endpoints therefore receive only the exact directed augmentation needed for one Euler trail from start to end.
- A partial start traverses the suffix of its actual Arc as a local `ACCESS` segment, then enters the Euler trail at the Arc's `to` node.
- A partial fixed end leaves the Euler trail at its Arc's `from` node and traverses the actual Arc prefix as a local `RETURN` segment.
- All full required Arc traversals remain `SERVICE`; balance duplicates remain `DUPLICATE_SERVICE`. Endpoint segments do not mutate or add Network Foundation entities.
- Route signatures are independent of input Arc ordering.

## Tests actually run

| gate | result | evidence |
|---|---|---|
| focused Open DCPP tests | PASS, 4 tests | distinct fixed terminal, terminal augmentation, partial continuity, deterministic replay, mode fail-closed |
| machine Open DCPP gate | PASS, 7 checks | `s01-open-dcpp-s01-20260825t1105.json` |
| generated contract validation | PASS | Coverage Route and Solver Diagnostics |
| strict build/typecheck | PASS | repository TypeScript and STAS |
| full repository Vitest regression | PASS, 205 tests | 40 files passed; one pre-existing optional test skipped |
| predecessor/source/boundary guards | PASS | exact v0.5 locks, reference-only policy, authority boundaries |

The machine evidence includes both a partial-state trail with zero residual imbalance and a distinct-node terminal case that adds exactly one minimum-cost `A -> B` traversal to produce the requested open degree vector.

## Acceptance IDs

`AC-S004` and `AC-S005` are PASS. Required-subset/full-network connector behavior begins in S02; strict turns, conditions, objective metrics, determinism/load, and explicit negative guards remain assigned to S03.

## Commit / push / PR

S01 is delivered as a semantic phase commit, pushed, and reflected in Draft PR #4.

## Blockers / next

No S01 blocker. Proceed to S02 Fixed-direction and Both-directions-required RPP over separate `R` and `E`.
