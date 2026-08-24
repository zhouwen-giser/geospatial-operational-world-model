# GOWM database image third-party notices

The GOWM database image is an aggregation of independently licensed components.

| Component | Locked version | License | Source/build provenance |
|---|---:|---|---|
| PostgreSQL | 18.x from pinned MobilityDB base image | PostgreSQL License | `mobilitydb/mobilitydb:18-3.6-1.3@sha256:8409e3897e2b88561bef4374110c3da5f7ff56838a7745315f1c2f111305dd24` |
| PostGIS | 3.6.x from pinned MobilityDB base image | GPL-2.0-or-later | same pinned base image |
| MobilityDB | 1.3.x | PostgreSQL License | same pinned base image |
| h3-pg / h3_postgis | 4.5.0 | Apache-2.0 | official PGXN archive, SHA-256 `72f48359cd49ffaa38eb22fbaa607d5497e0144a8f94824f826beb0b370c40d8` |
| pgRouting | 4.0.1 | GPL-2.0-or-later | official release archive, SHA-256 `21c071983a682e048da28f0f211205a20f27ef3708c0b637b4e6e29994d7d699` |

The complete pgRouting GPL-2.0 text is installed at `/usr/share/doc/gowm-pgrouting/LICENSE`. The source archive remains available from `https://github.com/pgRouting/pgrouting/releases/tag/v4.0.1`; the database Dockerfile is the complete build recipe used for the installed binary.

Distribution of a built image requires preservation of these notices, the included SPDX SBOM, all upstream notices inherited from the base image, and satisfaction of the corresponding-source obligations of every GPL component.
