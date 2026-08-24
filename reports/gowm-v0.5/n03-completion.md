# N03 Profiles, Costs and Conditions Completion

## Scope completed

Implemented ROAD_VEHICLE and UGV travel-profile legality, strict one-way enforcement, integer fixed-point distance/time/risk/energy/surface costs, deterministic weighted cost with BigInt intermediate arithmetic, and immutable Condition Snapshots for closure, speed, risk, access and multiplier overrides. OSM PREVIEW materialization now requires exact ODbL-1.0 license, `© OpenStreetMap contributors` attribution, HTTPS source and source version.

Migration 042 aligns the append-only database with the frozen v0.5 contract by adding surface weight PPM, authoritative `energy_mwh`, and explicit risk/access/multiplier condition columns. The original energy millijoule column remains for compatibility. Read views expose the new columns without changing Provider base-table authority.

## Real database evidence

- Runtime run: `n03-20260825t0158`
- Isolated database: `gowm_v05_n03_20260825t0158`
- Source template: verified N02 database `gowm_v05_n02_20260825t0149`
- ROAD_VEHICLE profile versions: 1
- UGV profile versions: 1
- Eligible fixed-point Arc cost rows: 3
- Exact distance/duration/energy recomputation: PASS
- Strict one-way: PASS
- Condition Snapshots: 2
- Closed Arc exclusions: 1
- Risk override rows with evidence: 1
- Baseline duration: 11132 ms
- Changed duration under pinned speed override: 22264 ms
- Base Arc speed unchanged: PASS
- Historical snapshot replay hash: PASS

The machine transcript is `reports/gowm-v0.5/n03-runtime-n03-20260825t0158.json`.

## Tests actually run

| command | result | evidence |
|---|---|---|
| focused Catalog/Profile/Cost/Condition tests | PASS | 8 ODbL, filtering, one-way, fixed-point, weighted and snapshot tests |
| `npm.cmd run verify:sql` | PASS | 42 migration ASTs and 27 assertion ASTs |
| `npm.cmd run check` | PASS | generated contracts, TypeScript and STAS typecheck |
| `npm.cmd run validate:network-profile-runtime` | PASS | real PostgreSQL topology/profile/cost/snapshot writer and SQL recomputation |
| `npm.cmd run verify` | PASS | recorded after phase evidence files were added |

## Blockers

None for N03.

## Next phase

N04 graph diagnostics, reproducible validation, failed-build isolation and atomic activation.
