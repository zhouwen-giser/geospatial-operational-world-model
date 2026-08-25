# B01 Canonical Coverage Problem Completion

## Phase / scope

B01 turns a verified obligation set plus normalized terminal candidates, endpoint/boundary policy, objective, and resource budgets into a deterministic immutable Coverage Problem. It does not load or copy Network authority and does not solve the problem.

## Canonical identity

- Each obligation hash is bound to the full RoutingSnapshot, graph/edge/Arc identity, oriented integer fractions, required passes, policy version, and source ReferenceKeys.
- Obligation ledgers sort by Arc, fractions, then identity; caller row order cannot change the set ID or problem hash.
- Entry and exit candidate sets are normalized by Arc, fraction, and direction. Start and fixed-end states retain their directed meaning.
- The problem hash includes snapshot, terminals, policies, canonical ledger, objective, and budgets. It excludes only the derived `problemId` and self `problemHash` fields.
- `problemId` is derived from the problem hash. Snapshot drift, empty ledgers, tampered obligation content, invalid fixed-end conditions, and invalid budgets fail closed before persistence.

## Tests actually run

| gate | result | evidence |
|---|---|---|
| focused canonical problem unit tests | PASS, 6 groups | schema validity, permutation, key order, sensitivity, tamper, fail-closed conditions |
| combined B00/B01 focused tests | PASS, 16 tests | obligation and problem identity |
| canonical permutation gate | PASS, 36 combinations | `b01-canonical-b01-20260825t1010.json` |
| root build/check | PASS | generated contracts and strict TypeScript |

The permutation gate validates every 3! obligation order × 3! entry/exit candidate order against the frozen `coverage-problem` JSON Schema and observes exactly one obligation-set hash and one problem hash.

## Acceptance IDs

`AC-C013`, `AC-C014`, and the B00/B01 shared `AC-O020` are PASS. The remaining typed runtime error row `AC-C015` stays assigned to P00; no Provider or solver readiness is claimed.

## Failed attempt retained

The first snapshot sensitivity fixture combined a new problem snapshot with old-snapshot obligation hashes. The production tamper guard correctly rejected the mismatch. The test now regenerates legal obligation identities for the new snapshot and proves the resulting problem hash changes.

## Commit / push / PR

B01 is delivered as a semantic phase commit, pushed, and reflected in Draft PR #4.

## Blockers / next

No B01 blocker. Proceed to E00 directed start, boundary candidate, endpoint, and crossing-policy normalization.
