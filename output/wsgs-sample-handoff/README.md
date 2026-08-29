# GOWM WSGS Sample World handoff

This handoff describes the running, synthetic v1 sample world for WSGS Grounding Core integration.

- Gateway Base URL from the host: `http://127.0.0.1:18063`
- Gateway Base URL from a WSGS container on the same host: `http://host.docker.internal:18063`
- Final authentication mode: `SIGNED_DELEGATION_V1`
- Bearer token environment variable: `GOWM_WSGS_SAMPLE_TOKEN`
- Delegation signing-key path environment variable: `GOWM_WSGS_DELEGATION_PRIVATE_KEY_PATH`
- Service principal: `service:wsgs`
- Visible data/dataset scopes: `wsgs-demo` / `wsgs-demo-main`
- Fixture/realization: `gowm-wsgs-sample-world@1.0.0` / `sample-realization-b24a5c48-e1f0-5031-90df-29d21d068777`

Use only the single Gateway Base URL. Provider endpoints, container topology, database credentials, bearer values and signing-key bytes are deliberately absent. Build requests from `CONSUMER_CONTRACT_LOCK.json`, resolve fixture identities through `SAMPLE_REFERENCE_MAP.json`, and run `EXPECTED_CASES.json` plus `reference.validate@1.0` and `result.validate@1.0`.

## Operator lifecycle

From the repository root on the host:

```powershell
# Build, start, qualify, reset and leave the instance at v1.
npm.cmd run sample-world:all

# Read live signed availability plus the database marker, realization and revision.
npm.cmd run sample-world:status

# Guardedly clear only fixture state, reload v1 and verify it.
npm.cmd run sample-world:reset

# Stop the instance while preserving its dedicated volumes.
npm.cmd run sample-world:down
```

For a manual start, run `npm.cmd run sample-world:up`, then `npm.cmd run sample-world:load`, and finish with `npm.cmd run sample-world:status`. The handoff command refuses to publish artifacts unless the live instance is on the current realization's v1 baseline and all required operations are available.

The instance is left at the v1 baseline after mutation/reset/restart qualification. North-gate boundary membership follows PostGIS `ST_Covers` semantics, so boundary points are included. Nearby results may include the center object; expected references are required members rather than an undocumented filtered set.

`CONSUMER_CONNECTIVITY_REPORT.json` records the independent container-side signed smoke against the WSGS container URL without recording credentials.
