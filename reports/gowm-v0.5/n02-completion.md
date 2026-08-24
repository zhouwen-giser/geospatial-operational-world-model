# N02 Turn Restrictions Completion

## Scope completed

Implemented clean-room pairwise and multi-edge turn restriction compilation against directed Arc topology. Source feature sequences resolve only when a unique contiguous directed path exists. Pairwise and sequence rules receive stable keys and content hashes; multi-edge rules compile into a deterministic prefix/suffix automaton that supports overlapping FORBIDDEN and PENALTY matches without delegating turn semantics to pgRouting.

Unresolved FORBIDDEN/ALLOWED_ONLY restrictions produce activation-blocking FATAL diagnostics. Unresolved PENALTY restrictions produce non-blocking WARNING diagnostics. Invalid penalty/type combinations fail closed.

## Real database evidence

- Runtime run: `n02-20260825t0149`
- Isolated database: `gowm_v05_n02_20260825t0149`
- Source template: verified N01 database `gowm_v05_n01_20260825t0101`
- Pairwise rules persisted: 1
- Multi-edge sequence rules persisted: 2
- FATAL diagnostics persisted: 1
- WARNING diagnostics persisted: 1
- Database sequence-continuity guards: PASS
- Activation probe: blocked with `graph version has activation-blocking validation issues`
- Automaton hash: `sha256:d40aa93934209b81a05341f3f2e7f44e5ff344ef87cb155b856004c1cecf0889`
- Restriction content hash: `sha256:4a26a2156289a2ce665c07a07f864b073ac4f340ed03b4188ae7007caf2b9016`

The machine transcript is `reports/gowm-v0.5/n02-runtime-n02-20260825t0149.json`. The earlier permission failure is retained separately and does not contribute PASS evidence.

## Runtime permission repair

Real insertion found that GraphVersion and feature-binding validation triggers needed Catalog base rows but ran with the builder invoker's deliberately restricted privileges. Migration 041 changes only these trigger-only validators to controlled `SECURITY DEFINER` functions; their fixed `search_path` and revoked public execution remain. Assertion 026 proves `network_builder` still has no direct Catalog base-table SELECT.

## Tests actually run

| command | result | evidence |
|---|---|---|
| focused `network-turn-restrictions.test.ts` | PASS | 6 pairwise, sequence, overlapping automaton, replay, diagnostic and fail-closed tests |
| `npm.cmd run verify:sql` | PASS | 41 migration ASTs and 26 assertion ASTs |
| `npm.cmd run check` | PASS | generated contracts, TypeScript and STAS typecheck |
| `npm.cmd run validate:network-turn-runtime` | PASS | real PostgreSQL writer, triggers, diagnostics and activation rejection |
| `npm.cmd run verify` | PASS | recorded after phase evidence files were added |

## Blockers

None for N02.

## Next phase

N03 travel profiles, fixed-point cost profiles, and immutable Condition Snapshots.
