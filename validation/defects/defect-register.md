# Defect register

| ID | Severity | Root cause and fix | Final regression evidence | Status |
|---|---|---|---|---|
| GSI-001 | P2 | Debian/PGDG transient metadata failures; switched to HTTPS and bounded APT update retries | final database/application image builds completed | FIXED |
| GSI-002 | P1 | PGDG PG18 h3 extension lagged at 4.2.3; build checksum-pinned official PGXN 4.5.0 source | runtime reports h3 and h3_postgis 4.5.0 | FIXED |
| GSI-003 | P2 | Docker user-defined subnet pool exhausted; validation-only built-in bridge override avoids deleting unrelated networks | two isolated projects started without network deletion | FIXED |
| GSI-004 | P1 | h3_postgis 4.5 requires PostGIS Raster; migration 008 now creates it first | fresh install reports postgis_raster 3.6.4 | FIXED |
| GSI-005 | P1 | coverage scope FK lacked a matching deployment unique key | fresh migration 010 applied and fixture coverage inserted | FIXED |
| GSI-006 | P1 | MobilityDB assertion omitted a defaulted boolean from function identity | live assertion suite PASS | FIXED |
| GSI-007 | P1 | unknown timestamp literals made MobilityDB overload resolution ambiguous | UNKNOWN-gap live assertion PASS | FIXED |
| GSI-008 | P1 | Compose health observed the temporary bootstrap postmaster | PID-1 health gate enabled; clean migration 001-010 PASS | FIXED |
| GSI-009 | P1 | restricted STAS could not resolve extension symbols in `public` | public schema USAGE only; all 15 tools PASS and base tables denied | FIXED |
| GSI-010 | P1 | scope-validation trigger inherited caller and could not inspect authority tables | security definer with fixed search path; persistence/replay/scope denial PASS | FIXED |
| GSI-011 | P1 | POSITION insert had ambiguous SRID bind and one missing value expression | three canonical HTTP ingests, immutable versions, replay and STAS chain PASS | FIXED |
| GSI-012 | P1 | 10,001 candidate scope lacked a composite logical-tracklet access path | scoped index present; cap returns 422 at 5,001 and analyzed probe completes in 45.179 ms | FIXED |

No open P0/P1 implementation defect remains in the v0.1.0 integration scope.
Production-qualification gaps are recorded as explicit `PARTIAL`, `NOT_RUN`, or
`BLOCKED` items in `validation/FINAL_ACCEPTANCE.md`, not hidden as code defects.
