# Input baselines

The original archives in `docs/` are immutable intake artifacts. They are not
included in the platform delivery archive and are ignored by Git. Audit copies
were expanded under the ignored `.intake/` directory.

| Logical input | Actual input path | Size (bytes) | SHA-256 | Internal integrity |
|---|---|---:|---|---|
| GOWM+ v1.2 | `docs/geospatial-world-model-poc-v1.2.zip` | 258341 | `BFB0CDB6AFAFBE12EA21F9507533FA0E3A5D5701C36C0FF6DA54B5C4729709A6` | bundled `SHA256SUMS`: PASS |
| STAS v1 Phase 0 | `docs/mobilitydb-stas-v1-phase0-validated.zip.zip` | 334446 | `17386A54FF1B8019F4950C39F798820D05DB7D27EC057C29F8489883EF583106` | bundled `source-final.sha256`: PASS |

The objective named the second file with one `.zip` suffix; the supplied file
has two. The bytes above, rather than the expected spelling, define the audited
input.

## Component inventory

GOWM+ v1.2 contributes the world, observation-ingest, projection-worker, and
MCP services; runtime/domain packages; migrations 001-009; PostGIS/H3/MobilityDB
image; and its unit/scenario/integration tests.

STAS v1 contributes the independently deployable Fastify analysis service,
OpenAPI 3.1 contract, 15-tool registry and Zod schemas, 19 bounded SQL templates,
Phase 0 fixtures/assertions, and prior real-container evidence. The prior
evidence is baseline evidence only and is not counted as verification of the
integrated source.

## Verification boundary

The source manifests were checked byte-for-byte after extraction. The STAS
baseline reports PostgreSQL 18.4, PostGIS 3.6.4, MobilityDB 1.3.0 and all 15 SQL
and HTTP tools passing in its standalone schema. GOWM+ reports Node/static gates
passing but its real combined database gates not run. Every integrated gate is
therefore rerun and reported separately.
