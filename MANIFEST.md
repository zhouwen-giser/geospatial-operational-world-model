# GOWM+ v0.1.0 engineering manifest

Prepared: 2026-08-13

## Included

- unified TypeScript source under `packages/`, `services/`, `scripts/`, and `simulator/`
- PostgreSQL migrations 001-010 and deterministic validation fixtures
- pinned database and application Dockerfiles plus Compose topology
- independent STAS service, OpenAPI, 15-tool registry, SQL templates, and tests
- architecture, ADR, ownership, operations, verification, traceability, and defects
- npm dependency locks and final package checksum manifest

## Excluded

- input ZIP archives and `.intake/` extraction workspace
- credentials, `.env`, node_modules, compiled dist, logs, and Docker volumes
- production data or operating-area CRS certification

## Evidence classification

- `PASS`: executed successfully in the isolated validation project
- `PARTIAL`: some sub-gates executed, but the whole capability is not qualified
- `NOT_RUN`: no runtime evidence was produced
- `BLOCKED`: a required external authority or environment is absent

The authoritative status is `validation/FINAL_ACCEPTANCE.md`. Historical source
reports in `docs/01_*` through `docs/16_*` are retained as baseline material and
must not override the v0.1.0 ownership or acceptance records.

The generated archive itself is intentionally git-ignored; `SHA256SUMS` covers
every file inside the extracted package, while the archive digest is reported at
delivery time to avoid a circular self-hash.
