# N04 Validation and Activation Completion

## Scope completed

Added controlled Catalog Feature binding resolution and atomic GraphVersion activation. Migration 043 removes direct activation-event INSERT from `network_builder` and exposes a single definer function protected by a graph-scoped transaction advisory lock. Each switch appends RETIRE for the old head and ACTIVATE for the new head in one transaction. Historical versions and topology remain immutable and queryable by pinned ID.

The Foundation binding writer resolves only Feature versions belonging to the GraphVersion's authoritative Dataset/scope, then persists one evidence-bearing binding per physical Edge without granting Catalog base-table access.

## Real database evidence

- Runtime run: `n04-20260825t0228`
- Isolated database: `gowm_v05_n04_20260825t0228`
- Concurrent activation calls: 2
- ACTIVATE events: 2
- RETIRE events: 1
- Final active head: exactly 1
- Retained validated versions: 2
- Retired pinned-version Arc rows: 2
- Injected FAILED builds: 1
- Active head unchanged by failed build: PASS
- Replay topology hash: `sha256:a712890f56f6cf8a247c46e0ccb605bcec2321edecc9b1c3d68638cf3ed364fa`
- Replay content hash: `sha256:d49d48e81129b2885ddd6e8dd26db3f0a1615edec0d550c774a883b38b995921`

The machine transcript is `reports/gowm-v0.5/n04-runtime-n04-20260825t0228.json`. Two earlier fail-closed fixture/scope transcripts are retained and do not contribute PASS evidence. One tool sub-session ended without a report and is not counted.

## Tests actually run

| command | result | evidence |
|---|---|---|
| `npm.cmd run verify:sql` | PASS | 43 migration ASTs and 28 assertion ASTs |
| `npm.cmd run check` | PASS | generated contracts, TypeScript and STAS typecheck |
| `npm.cmd run validate:network-activation-runtime` | PASS | concurrent activation, pinned history, failed-build isolation and replay |
| `npm.cmd run verify` | PASS | recorded after phase evidence files were added |

## Milestone

`NETWORK_READY` — N00 through N04 Required gates pass with real PostgreSQL evidence.

## Blockers

None for N04.

## Next phase

P00 read-only `gowm.network` Provider operations.
