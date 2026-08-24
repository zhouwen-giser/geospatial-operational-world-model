# D02 Network Read Contract Completion

## Scope completed

Added migration `039_gowm_network_v1_read_contract.sql`, the sole scoped SQL read surface for network and basic routing. It exposes eleven security-barrier views and five controlled functions without granting either Provider access to public Network Foundation tables.

## Source state

- Previous phase commit: `14596cd`
- Draft PR: #3
- Runtime run ID: `d01-d02-20260824t2353`
- Fresh database: `gowm_v05_d01_d02_20260824t2353`

## Read contract

Views: `graph_version`, `node`, `edge`, `arc`, `turn_rule`, `turn_sequence_rule`, `travel_profile`, `cost_profile`, `arc_cost`, `condition_snapshot`, and `arc_condition`.

Controlled functions: `set_scope`, `resolve_active_graph`, `resolve_routing_snapshot`, `snap_candidates`, and `routing_arc_projection`.

`network_provider` and `route_planner_provider` are NOLOGIN, transaction-read-only roles. Both read through `gowm_network_v1`; only the route-planner role can execute `routing_arc_projection`. Neither has public base-table SELECT or write privileges.

## Tests actually run

| command/gate | result | evidence |
|---|---|---|
| final D01/D02 runtime gate | PASS | 67/67 commands, migrations 001–039 and assertions 001–024 |
| `024_gowm_network_v1_assertions.sql` | PASS | views, active graph, complete RoutingSnapshot, directed snap candidates, route projection, role denial and cross-scope empty results |
| focused read-contract Vitest | PASS | 2 tests |
| `npm.cmd run verify:sql` | PASS | all 39 migrations and 24 assertions parse |
| `npm.cmd run verify` | PASS | 133 Vitest tests plus one explicit skip, 39 STAS tests, contracts, SQL AST, typecheck and build |

The authoritative runtime transcript is `reports/gowm-v0.5/d01-d02-runtime-d01-d02-20260824t2353.json`.

## Acceptance cases

`AC-N010` passes through composite scope foreign keys plus runtime-verified `gowm_network_v1` DataScope/DatasetScope filtering. Cross-scope graph existence, rows, active resolution and candidates are not exposed.

## Security review

- `set_scope` validates the DataScope/DatasetScope pair and stores it transaction-locally.
- All topology views join back to a scoped GraphVersion.
- Snap accepts a bounded limit of 1–32 and returns directed Arc candidates; it never chooses an arbitrary first Arc.
- Provider callers cannot submit arbitrary SQL, table names, schemas, URLs, or algorithms through the read contract.
- pgRouting-ready projection remains route-planner-only; Gateway and Network Provider receive no algorithm primitive.

## Failed attempts retained

Five development runs are retained as FAIL evidence. They found: an ambiguous `dataset_id` join in migration 039; a 3D fixture incorrectly written to the existing 2D source Feature column; a PL/pgSQL variable/column name collision; and two assumptions that a restricted Provider role could resolve or use PostGIS constructors from `public`. Fixes used explicit joins, correct source/network geometry separation, unambiguous variables, and an already-authorized view geometry parameter. No role or scope privilege was broadened.

## Commit/push/PR

Draft PR #3 remains Draft. No merge, tag, release, publication, or deployment is authorized.

## Blockers

None for D02.

## Next phase

N00 Catalog Build Adapter and deterministic graph identity.
