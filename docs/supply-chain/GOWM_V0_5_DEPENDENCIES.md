# GOWM+ v0.5 Network and Routing Dependency Policy

## Project license

GOWM+ is MIT licensed.

## pgRouting

The target database runtime adds pgRouting 4.0.1 as an external PostgreSQL extension while retaining PostgreSQL 18.x, PostGIS 3.6.x, MobilityDB 1.3.x, and H3/H3 PostGIS 4.5.x.

pgRouting is GPL-2.0-or-later. Any distributed combined database image must preserve its license and notices, publish source/build provenance, generate an SBOM, and record the immutable image digest. A different pgRouting version cannot satisfy the 4.0.1 required gate.

## User-supplied reference archive

The road coverage planner archive is locked by SHA-256 in `research/gowm-v0.5-source-lock.json`. It contains no project-level LICENSE and declares no package license. It is therefore reference-only and is not approved for redistribution or wholesale copying.

Only clean-room reimplementation of the explicitly mapped concepts is permitted. The expanded source, dependency trees, build output, coverage output, legacy schema, public coverage contracts, coverage solvers, worker lifecycle, and OR-Tools integration are excluded from v0.5.

## OSM fixtures

Any OSM test fixture used later in this work must retain ODbL-1.0 attribution and a source manifest. Large OSM artifacts are not committed unless their precise provenance and license policy are established.
