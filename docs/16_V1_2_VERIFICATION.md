# GOWM+ v1.2 verification status

Decision: **SOURCE_CONDITIONAL_PASS**

Validation date: 2026-08-13 UTC.

## Executed in this packaging environment

| Gate | Result | Evidence |
|---|---|---|
| Dependency install | PASS | clean npm install using package lock |
| TypeScript typecheck | PASS | `npm run check` |
| PostgreSQL grammar | PASS | migrations 001–009 parsed with PostgreSQL 18 parser through `npm run verify:sql` |
| Unit/scenario/MCP tests | PASS | 25 assertions; one database suite skipped by explicit environment gate |
| Production build | PASS | `npm run build` |
| Canonical observation model | PASS | receipt-time ownership, typed uncertainty/confidence separation, legacy UNKNOWN accuracy |
| Package lock/version | PASS | root package and lock both 1.2.0 |

The combined repeatable source gate is:

```bash
npm ci
npm run verify:v1.2
```

## Runtime assertions supplied but not executed here

`database/tests/001_v12_assertions.sql` checks on a real database:

- MobilityDB 1.3 and h3-pg 4.5 runtime line;
- compatibility view/archive shape;
- `tgeompoint(SequenceSet,Point)` storage;
- required stable MobilityDB functions and absence of unsupported geography/pair
  helpers;
- SequenceSet UNKNOWN-gap behavior and defined endpoints;
- tracker-session-aware builder signatures and append-only guards.

HTTP acceptance additionally publishes canonical v1.2 observations, reads their
typed evidence, creates a continuity-token cut and requires two MobilityDB
sequences with one open UNKNOWN gap.

## Evidence inherited only as reference

The separately supplied STAS Phase 0 report records a conditional pass on real
PostgreSQL 18.4/PostGIS 3.6.4/MobilityDB 1.3.0 containers and all 15 STAS P0
tools. That supports the chosen stable API line and application semantics. It is
not counted as execution of this GOWM+ migration, combined H3 image or API.

## Unresolved gates

- Docker image build and empty-volume migration 001–009;
- populated v1.1 restore/upgrade rehearsal;
- combined MobilityDB + h3-pg extension runtime;
- database assertions and API→DB acceptance;
- target operating-area CRS/transform error certification;
- backup/restore/PITR and RPO/RTO;
- authenticated data-scope claims, RBAC/RLS and adversarial tests;
- target-scale write rate, incremental builder, GiST plan and p95/p99 tests;
- pool exhaustion, timeout/cancellation and failure recovery;
- SBOM, vulnerability scan, signature and internal-registry promotion.

Until these pass, the package is appropriate for PoC integration and Phase 1
development, not production promotion.
