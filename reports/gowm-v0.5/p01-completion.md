# P01 Network Provider Real Acceptance Completion

## Scope completed

All `AC-P001..AC-P020` passed against an isolated clone using real PostgreSQL 18.6, PostGIS 3.6.4 and pgRouting 4.0.1. The gate creates separate ephemeral Builder and Provider LOGIN roles, never records their generated passwords, and drops both roles after completion. The database is retained as immutable run evidence.

The fixture includes directed ordinary paths, partial endpoints, disconnected components, legal/illegal profile arcs, same-geometry opposite-direction ambiguity, Heading ranking, Pairwise forbidden and penalty turns, Multi-edge forbidden sequences, alternatives, a closed Condition arc, and independent continuity/Turn mutations.

## Runtime evidence

- Run: `p01-20260825t0610`
- Database: `gowm_v05_p01_20260825t0610`
- AC rows: 20/20 PASS
- pgRouting differential distance: `222640`
- Provider hash before PostgreSQL restart: `sha256:19adb184100ed2716645673f1a1f3c96f40cf2318e81eac4d7b20664d996cd87`
- Provider hash after PostgreSQL restart: `sha256:19adb184100ed2716645673f1a1f3c96f40cf2318e81eac4d7b20664d996cd87`

The same Provider runtime and `pg.Pool` instance remained alive across `docker compose restart postgres`; the post-health call established a replacement connection and reproduced the pinned output hash.

## Least-privilege corrections discovered by real execution

The Provider correctly lacks Public Schema/PostGIS function visibility. Migration 044 therefore adds `heading_microdegrees` to the security-barrier Arc view and a controlled `snap_candidates_wgs84` definer function. Assertion 029 proves no Public execution grant or Public Schema usage was added. P00's direct `ST_*` calls were removed.

Database Arc keys are immutable internal `ar_<64hex>` identities while the frozen v0.5 Provider Schema requires `arc_<32..64hex>`. The Provider now performs a stable prefix-only boundary mapping; internal persistence keys remain untouched.

## Tests actually run

| command | result |
|---|---|
| `npm run validate:network-provider-runtime` | PASS, run `p01-20260825t0610` |
| SQL assertion 029 on the passing database | PASS |
| `npm run verify` | PASS: 159 Vitest, 1 explicit skip, 39 STAS, 44 migration/29 assertion ASTs, typecheck/build |

Failed run transcripts from `0320` through `0600` are retained. They exposed sandbox Docker denial, wrong host database routing, missing Builder mutation authority, activation binding enforcement, initialization order, direct PostGIS visibility, PostgreSQL expression typing, controlled snap visibility, frozen Arc-key mismatch, absent per-database pgRouting extension, final-segment budget accounting, attestation/deadline separation, an idle Builder-pool restart crash, and nondeterministic output timestamp injection. None is counted as PASS evidence.

## Blockers

None for P01.

## Next phase

R00 persistent Route runtime.
