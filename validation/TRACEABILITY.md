# v0.1.0 traceability

| Requirement | Implementation | Evidence/status |
|---|---|---|
| Audit both supplied baselines | `docs/intake/INPUT_BASELINES.md` | ZIP and internal-manifest hashes PASS |
| One canonical authority | ownership matrix, ADR, migrations 009-010 | PASS |
| Pinned PG18/PostGIS3.6/MobilityDB1.3/H3 4.5 | `database/Dockerfile`, migrations 008-010 | runtime versions PASS |
| Stable Observation/TimeSolution/Measurement/TrackletVersion | migration 009, observation repository | fresh migration and API-to-DB PASS |
| Versioned STAS adapter, no duplicate writer | `gowm_stas_v1`, restricted role, removed command code | role audit and route parity PASS |
| Independent STAS deployment | Compose `stas`, health/readiness | PASS |
| All 15 P0 tools | registry, repository, SQL templates, OpenAPI | 15/15 real HTTP+DB PASS |
| Evidence-oriented result persistence | `stas.analysis_*`, replay route | persistence/replay/scope denial PASS |
| Gap and uncertainty semantics | Mobility SequenceSet/gaps, domain tests | UNKNOWN gap and NO_DATA PASS |
| Candidate cap and plans | fixture 002, scoped index, evidence collector | 10,001 universe; cap 5,000; PASS |
| Repeatable engineering verification | npm scripts, SQL AST, unit tests, build | PASS |
| Backup/restore/PITR | operations runbook | procedure delivered; rehearsal NOT_RUN |
| Live MQTT recovery | durable queue/outbox observed during focused ingest E2E | PARTIAL; broker recovery NOT_RUN |
| Production authentication and CRS | deployment responsibility | BLOCKED pending external inputs |
| Merge/tag/release/deploy | protected action | NOT_RUN pending explicit authorization |

# v0.2 Capability Platform traceability

This section extends, and does not replace, the v0.1.0 traceability above.
Machine-readable acceptance details live in
`reports/capability-platform-v0.2/pXX-acceptance.json`; this document maps the
Required matrix to its owner and evidence boundary.

Status vocabulary:

- `PASS`: the stated acceptance behavior passed in the evidence class required
  by that row.
- `PARTIAL`: implementation or controlled evidence passed, but a required real
  process, database, fault, load, or delivery gate did not.
- `NOT_RUN`: no execution evidence was obtained for that required class.
- `BLOCKED`: an allowed external condition prevented the required execution or
  delivery; a fixture/static result is not substituted.

## Phase-to-acceptance map

| Phase | Required acceptance | Evidence artifact | Phase status |
|---|---|---|---|
| P00 | AC-001..AC-008 | `reports/capability-platform-v0.2/p00-acceptance.json` | PASS for intake/source baseline; later phases own AC-004..008 implementation proof |
| P01 | AC-009..AC-015 | `reports/capability-platform-v0.2/p01-contract-acceptance.json` | PARTIAL; AC-009..014 pass, final runtime OpenAPI parity is incomplete |
| P02 | AC-003..AC-008 | `reports/capability-platform-v0.2/p02-repository-framework-acceptance.json` | PARTIAL; implementation/build/boundaries pass, delivery blocked |
| P03 | AC-008, AC-016..AC-019 | `reports/capability-platform-v0.2/p03-provider-sdk-conformance-acceptance.json` | PARTIAL; real PostgreSQL idempotency/restart not run |
| P04 | AC-020..AC-024 | `reports/capability-platform-v0.2/p04-gateway-direct-execution-acceptance.json` | PARTIAL; controlled Gateway gates pass, real database restart incomplete |
| P05 | AC-025..AC-029 | `reports/capability-platform-v0.2/p05-foundation-local-ports-acceptance.json` | PARTIAL; critical-path code/rollback checks pass, live receipt/outage proof incomplete |
| P06 | AC-030..AC-036 | `reports/capability-platform-v0.2/p06-crs-provider-acceptance.json` | PARTIAL; real locked CRS process cases not run |
| P07 | AC-037..AC-044 | `reports/capability-platform-v0.2/p07-geometry-provider-acceptance.json` | PARTIAL; real locked Geometry worker cases not run |
| P08 | AC-045..AC-055 | `reports/capability-platform-v0.2/p08-h3-bridge-acceptance.json` | PARTIAL; real Toolkit API and JS/PG parity blocked |
| P09 | AC-049..AC-052, AC-080 | `reports/capability-platform-v0.2/p09-h3-situation-acceptance.json` | PARTIAL; delegation passes, real HTTP compatibility not run |
| P10 | AC-056..AC-061, AC-084..AC-086 | `reports/capability-platform-v0.2/p10-gowm-spatial-v1-acceptance.json` | PARTIAL; real fresh/upgrade/role/scope database gates not run |
| P11 | AC-062..AC-068 | `reports/capability-platform-v0.2/p11-spatial-provider-acceptance.json` | PARTIAL; real PostGIS correctness, plans, and mixed load not run |
| P12 | AC-069..AC-078 | `reports/capability-platform-v0.2/p12-world-query-runtime-acceptance.json` | PARTIAL; controlled DAG behavior passes, real restart persistence incomplete |
| P13 | AC-071..AC-075 | `reports/capability-platform-v0.2/p13-cross-capability-acceptance.json` | PARTIAL; controlled chains pass, real multi-service chains not run |
| P14 | AC-079..AC-083 | `reports/capability-platform-v0.2/p14-compatibility-acceptance.json` | PARTIAL; MCP gates pass, real dual-run incomplete and multi-scope Situation blocked |
| P15 | AC-019, AC-058, AC-089..AC-090 | `reports/capability-platform-v0.2/p15-security-snapshot-recovery-acceptance.json` | PARTIAL; controlled security/integrity passes, live scope/restart gates not run |
| P16 | AC-084..AC-094 | `reports/capability-platform-v0.2/p16-real-runtime-acceptance.json` | BLOCKED pending real Docker/PostgreSQL/external Provider execution |
| P17 | AC-093..AC-096 | `reports/capability-platform-v0.2/p17-final-candidate-acceptance.json` | BLOCKED; documentation is current, candidate SHA/PR Ready gates fail closed |

## Cross-cutting architecture traceability

| Requirement | Implementation | Evidence/status |
|---|---|---|
| Source release boundary (AC-003, AC-092) | `.gitignore`, approved vendored paths, source locks, release-boundary validator | PASS for repository inventory; only locked CRS/Geometry MIT source paths are publishable |
| Gateway has no domain engine/arbitrary execution (AC-004) | Gateway packages, frozen API, architecture validator | controlled architecture PASS |
| Providers never call Providers (AC-005) | Provider bridge dependency boundary | controlled architecture PASS |
| Foundation critical path is local (AC-006, AC-025..029) | Foundation ports and projection transaction | implementation PASS; live receipt/full outage PARTIAL |
| Operation-level contracts and extension (AC-007..015) | platform/capability schemas, generator, elevation mock | controlled contract PASS except final runtime OpenAPI parity PARTIAL |
| Provider/Gateway enforcement (AC-016..024) | SDK, conformance kit, Registry, direct execution, circuit, persistence | controlled PASS; PostgreSQL restart portions PARTIAL |
| CRS (AC-030..036) | CRS bridge, source lock, schemas, policy/receipt mapping | contract/security PASS; real process cases NOT_RUN |
| Geometry (AC-037..044) | Geometry bridge, explicit repair, unit guard, worker mapping | contract/security PASS; real worker cases NOT_RUN |
| H3 (AC-045..055) | locked Toolkit adapters/providers, Situation delegation, Notice/SBOM | semantics/supply chain PASS; real API/PG parity and exact chain PARTIAL/BLOCKED |
| Spatial contract and Provider (AC-056..068) | migration 012, `gowm_spatial_v1`, read-only role, parameterized repository | controlled/static PASS; real database correctness/security/performance PARTIAL/NOT_RUN |
| Typed DAG (AC-069..078) | World Query validation/runtime, persistence, explicit repair/candidate-exact plans | controlled PASS; real cross-service/restart evidence PARTIAL |
| Compatibility and MCP (AC-079..083) | dual-run adapters, deprecation, split fixed MCP surfaces | controlled PASS; real parity PARTIAL |
| Runtime/security/supply chain (AC-084..092) | migrations 011-014, runtime servers/config, redaction, source locks | implementation/static/controlled evidence present; required real runtime BLOCKED |
| Capability catalog (AC-093) | `README.md`, v0.2 architecture, checked-in Provider manifests | PASS; 50 manifest operations and maturity are documented |
| Known limits (AC-094) | `README.md`, `PROJECT_STATUS.md`, final candidate report | PASS; production auth, CRS/grid, HA/PITR/SLO, licenses, and live-gate blockers explicit |
| Exact remote candidate SHA (AC-095) | branch/local/remote inspection | BLOCKED; last committed SHAs match but do not include the uncommitted v0.2 worktree |
| PR Ready (AC-096) | Draft PR #1 | BLOCKED; Required real gates and delivery are incomplete, so PR remains Draft |

## Protected actions

No merge, tag, release, or deployment was performed. CRS and Geometry upstream
source/packages/images are now approved for MIT publication but were not
published by this change. Promotion still requires the remaining real gates, a
committed/pushed candidate SHA, updated machine evidence, and explicit user
control.
