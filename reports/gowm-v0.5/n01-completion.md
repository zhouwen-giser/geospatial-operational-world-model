# N01 Topology and Directed Arc Completion

## Scope completed

Implemented a deterministic Foundation-owned topology builder and transaction-scoped PostgreSQL writer. The builder segments at-grade crossings, preserves grade-separated and parallel ways, emits stable Node/Edge/directed Arc keys, enforces legal one-way direction, orients geometry to Arc endpoints, and uses integer nanodegrees, elevation millimetres, length millimetres, speed millimetres per second, and split PPM.

## Real database evidence

- Runtime run: `n01-20260825t0101`
- Fresh database: `gowm_v05_n01_20260825t0101`
- Migrations replayed: 001-040
- Written topology: 25 Nodes, 14 Edges, 27 directed Arcs
- One-way test edge: 1 Arc
- Bidirectional test edge: 2 Arcs
- Arc geometry orientation: all rows pass PostGIS endpoint checks and database triggers
- Topology replay hash: `sha256:163bd9090f61f610df209c7176090d22e22597251d578797471e0c65c1507864`
- Content replay hash: `sha256:f8ba0c3d91cecd7655f96576709782c69d403660117cba79c2dcd39353b799a0`

The machine transcript is `reports/gowm-v0.5/n01-runtime-n01-20260825t0101.json`. Earlier failed run transcripts are retained and marked `FAIL`; they do not contribute PASS evidence.

## Runtime permission repair

The first real writer execution found that `network_builder` had explicit table grants but lacked `USAGE` on schema `public`. Migration 040 grants schema visibility only; it does not add UPDATE/DELETE authority. SQL assertion 025 locks SELECT/INSERT availability and the absence of mutable topology grants.

## Tests actually run

| command | result | evidence |
|---|---|---|
| focused `network-topology-builder.test.ts` | PASS | 8 deterministic, crossing, direction, replay and fail-closed tests |
| `npm.cmd run verify:sql` | PASS | 40 migration ASTs and 25 assertion ASTs |
| `npm.cmd run check` | PASS | generated contracts, TypeScript and STAS typecheck |
| `npm.cmd run validate:network-topology-runtime` | PASS | fresh PG18/PostGIS/pgRouting database and least-privilege container-network writer |
| `npm.cmd run verify` | PASS | recorded after phase evidence files were added |

## Security and lifecycle

The real gate uses a unique temporary LOGIN role that inherits only `network_builder`; credentials are passed by environment name, redacted from evidence, and the role is dropped after the run. Database provisioning remains inside the isolated Compose management path. No existing database password is changed.

## Blockers

None for N01.

## Next phase

N02 pairwise and multi-edge turn restriction ingestion, deterministic compiler, and sequence automaton.
