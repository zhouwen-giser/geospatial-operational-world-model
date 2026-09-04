# OpenDRIVE task-network v0.1 evidence

This directory is the machine-readable handoff boundary for the locked `airport2.xodr` task network.

- `SOURCE_LOCK.json` and `COMPILE_REPORT.json` are produced by the compiler.
- `artifacts/` contains deterministic compiler output and `SHA256SUMS`.
- `GOWM_GRAPH_REPORT.json` is produced by `admit`; dry-run is explicitly `NOT_RUN` for database acceptance.
- `ROUTING_E2E_REPORT.json` is produced by `verify`; it may claim `PASS` only after real Network Provider calls.
- `GDPS_IMPORT_REPORT.json` belongs to the GDPS repository workflow and is consumed here only as cross-repository evidence.
- `FINAL_ACCEPTANCE_REPORT.json` aggregates the current-run evidence without upgrading `NOT_RUN` or `BLOCKED` states.

Reports must not contain database credentials, Provider tokens, or unnecessary absolute host paths. The only valid gate states are `PASS`, `FAIL`, `NOT_RUN`, and `BLOCKED`.

The deployment archive copies this directory through an exact file whitelist. It does not include ordinary fixtures, examples, test-data trees, or the raw host-side XODR/oracle. The raw inputs remain governed by `SOURCE_LOCK.json` and are mounted read-only from explicit absolute paths when `compile` runs.

The stable cross-repository interface paths are:

```text
artifacts/physical-roads.geojson       -> GDPS ROAD_SOURCE primary vector input
artifacts/routing-channels.geojson     -> GOWM Catalog routing_channels layer
artifacts/allowed-transitions.json     -> GOWM ALLOWED_ONLY turn rules
artifacts/identity-map.json            -> source/GDPS/GOWM traceability
artifacts/compile-manifest.json        -> source, transform, compiler, topology, content hashes
artifacts/admission-plan.json          -> deterministic Catalog/GraphVersion management-plane input
artifacts/SHA256SUMS                   -> byte-level handoff lock
```
