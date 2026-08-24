# D00 Database Image Completion

## Scope completed

Extended the pinned PostgreSQL 18 / PostGIS 3.6 / MobilityDB 1.3 / H3 4.5 database image with an exact source build of pgRouting 4.0.1. Added source checksums, OCI labels, the full pgRouting license, third-party notices, an SPDX 2.3 SBOM, a fail-closed runtime gate, and a fraction=1 `pgr_withPoints` regression.

## Source state

- Previous phase commit: `2f82a2b6868973ff04193dbaf8c53eebf3e4c101`
- Draft PR: #3
- Runtime run ID: `gowm-v05-d00-20260824t2245-codex`
- Image content digest: `sha256:a502c7ce9ef773b4e0f4097ade3b88172f901d1e2d17ed246932d38a04026fae`

## Runtime versions actually observed

| component | result |
|---|---:|
| PostgreSQL | 18.6 |
| PostGIS | 3.6.4 |
| MobilityDB | 1.3.0 |
| h3 / h3_postgis | 4.5.0 / 4.5.0 |
| pgRouting | 4.0.1 |

## Tests actually run

| command/gate | result | evidence |
|---|---|---|
| `npm.cmd run validate:network-db-runtime` | PASS | 63/63 recorded commands passed |
| image build and isolated Compose startup | PASS | database reached healthy state |
| baseline migrations `001-032` in the target image | PASS | 32/32 individually recorded |
| existing SQL assertions `001-021` in the target image | PASS | 21/21 individually recorded |
| pgRouting assertion `022` | PASS | exact versions and fresh extension creation |
| fraction=1 `pgr_withPoints` corpus | PASS | terminal cost 17; edges `{100,101}` |
| license file in built image | PASS | non-empty installed license verified |
| `npm.cmd run verify` | PASS | 25 Vitest files passed plus one explicit skip; 128 tests passed plus one skip; 39 STAS tests passed; SQL AST, generated contracts, typecheck and build passed |

The authoritative runtime transcript is `reports/gowm-v0.5/d00-runtime-gowm-v05-d00-20260824t2245-codex.json`.

## Acceptance cases

`AC-D001` through `AC-D007` all pass with real container/database evidence.

## Source reuse and license review

The image uses the official pgRouting v4.0.1 archive with SHA-256 `21c071983a682e048da28f0f211205a20f27ef3708c0b637b4e6e29994d7d699`. The Dockerfile is the build recipe; the GPL-2.0-or-later declaration, full license text, source location, checksum, notices, and SPDX entry ship with the image.

## Failed attempts retained

- Docker Desktop 4.81.0 initially crashed on stale zero-byte Windows Unix-socket reparse points. Read-only process, WSL and log inspection preceded a controlled cold restart. Four exact transient sockets were removed; no image, container, configuration or volume was deleted. Docker Engine 29.6.1 then recovered.
- The first extended gate attempted the baseline replay through a fixed host port and failed password authentication. The gate was corrected to execute each migration/assertion inside the isolated Compose container, removing host-port ambiguity, and the complete rerun passed.

## Commit/push/PR

Draft PR #3 remains Draft. No merge, tag, release, image publication, or deployment is authorized.

## Blockers

None for D00.

## Next phase

D01 append-only network schema migrations and immutable graph-version constraints.
