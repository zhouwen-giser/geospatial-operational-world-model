# N00 Catalog Build Adapter Completion

## Scope completed

Added the Foundation-owned `@gowm/network-foundation` package with a fixed-query `gowm_catalog_v1` repository, NETWORK DatasetVersion validation, layer allowlisting, deterministic source materialization, fixed-point coordinate normalization, source/build identity hashes, and stable Node/Edge/directed Arc key primitives. Added an explicitly non-Stable OSM artifact PREVIEW adapter with locked provenance warnings.

## Source state

- Previous phase commit: `ba7dadf`
- Draft PR: #3

## Invariants

- The Catalog repository accepts a checked-out PostgreSQL transaction client so transaction-local scope cannot drift across pooled connections.
- A DatasetVersion must be `NETWORK`, same DataScope/DatasetScope, content-hashed, and selected by ReferenceKey + version.
- Only allowlisted line layers are materialized.
- Coordinates normalize to integer nanodegrees and elevation millimetres before identity hashing.
- Source ordering does not affect source or graph identity hashes.
- Zero-length/invalid/non-finite inputs fail closed.
- OSM artifact ingestion remains `OSM_ARTIFACT_PREVIEW` and requires an immutable artifact hash.

## Tests actually run

| command | result | evidence |
|---|---|---|
| focused `network-catalog-build.test.ts` | PASS | 4 deterministic/fail-closed/preview/key tests |
| `npm.cmd run check` | PASS | generated contracts, TypeScript and STAS typecheck |
| `npm.cmd run verify` | PASS | recorded after final phase files were added |

## Acceptance cases

`AC-N011` stable key primitives pass. `AC-N012` source/build identity reproducibility passes at materialization scope and is rechecked with complete topology/content hashes in N01.

## Source reuse and license review

No code was copied from the unlicensed reference archive. The adapter and key derivation are clean-room implementations of the frozen GOWM contracts.

## Blockers

None for N00.

## Next phase

N01 topological segmentation and directed Arc build.
