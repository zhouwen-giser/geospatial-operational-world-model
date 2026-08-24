# D01 Network Schema Completion

## Scope completed

Added append-only migrations `033–038` for the authoritative Network Foundation: Graph/GraphVersion, Node/Edge/directed Arc, source Feature binding, pairwise and sequence turn restrictions, versioned travel/cost profiles, fixed-point arc costs, versioned conditions, build/validation records, and append-only activation events.

## Source state

- Previous phase commit: `08aa5db449a4de1749e4bb215a1f7fe03259c56e`
- Draft PR: #3
- Runtime run ID: `d01-20260824t2359`
- Fresh database: `gowm_v05_d01_20260824t2359`

## Migrations

| migration | responsibility |
|---|---|
| 033 | scoped graph/catalog identity and immutable GraphVersion |
| 034 | PointZ/LineStringZ Node, Edge, directed Arc topology |
| 035 | source Feature bindings and pairwise/multi-edge turn rules |
| 036 | immutable travel/cost profile versions and fixed-point arc costs |
| 037 | immutable condition snapshots and per-Arc conditions |
| 038 | build runs, validation issues, activation events and builder role |

Migrations `001–032` were not modified.

## Tests actually run

| command/gate | result | evidence |
|---|---|---|
| D01 bounded runtime gate | PASS | 65/65 commands, migrations 001–038 and assertions 001–023 |
| `023_network_schema_assertions.sql` | PASS | NETWORK dataset pinning, immutable Graph/Node/Edge/Arc/Turn/Profile, versioned conditions, source binding, scope FK and builder privilege |
| focused Vitest schema tests | PASS | 3 tests |
| `npm.cmd run verify:sql` | PASS | migrations 001–039 and assertions 001–024 parse |
| `npm.cmd run verify` | PASS | 133 Vitest tests plus one explicit skip, 39 STAS tests, contracts, SQL AST, typecheck and build |

The authoritative D01 runtime transcript is `reports/gowm-v0.5/d01-d02-runtime-d01-20260824t2359.json`.

## Acceptance cases

`AC-N001` through `AC-N009` pass. `AC-N010` passes at the schema/composite-FK layer and is rechecked through the SQL read contract in D02.

## Invariants enforced

- GraphVersion and all topology/profile/rule rows reject UPDATE and DELETE with SQLSTATE `55000`.
- Edge/Arc geometries are 3D, endpoint-aligned, non-empty and valid.
- One-way edges reject illegal reverse Arc creation.
- Sequence restrictions require existing, contiguous directed Arcs.
- Every activated Edge has an authorized same-scope source Feature binding.
- Conditions are new snapshots and never update base Arcs.
- Activation is an append-only event and fails if counts, bindings, validation status, or graph status are invalid.

## Failed attempts retained

The combined D01/D02 development gate found and fixed an ambiguous join in migration 039, incorrect 3D source Feature fixtures, a PL/pgSQL variable ambiguity, and two restricted-role PostGIS construction assumptions. None of the fixes weakened schema, scope, geometry, or privilege constraints. D01 was then rerun independently without migration 039 or assertion 024.

## Commit/push/PR

Draft PR #3 remains Draft. No merge, tag, release, publication, or deployment is authorized.

## Blockers

None for D01.

## Next phase

D02 `gowm_network_v1` scoped read contract and Provider roles.
