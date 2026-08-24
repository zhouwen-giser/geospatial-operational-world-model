# P06 CRS Provider Bridge

Status: **implementation PASS; phase PARTIAL**

## Scope completed

The GOWM-owned CRS Provider Bridge is implemented as an independently written
protocol adapter. It registers exactly the six required operations, uses the
shared Provider SDK and canonical contract runtime, validates both the locked
POC response and the platform result, and never embeds a CRS engine.

The only upstream destination is an approved Registry endpoint supplied at
startup. The endpoint ID and normalized base URL must match a SHA-256 approval
digest. Execution requests cannot select a URL, route, target CRS, PROJ string,
vertical datum, Grid, network policy, or raster operation. The bridge never
calls the POC convenience `/v1/normalize` endpoint.

The bridge fixes output to `EPSG:4326` using traditional GIS order, requires
strict best-operation policy with PROJ network access disabled, maps missing
Grid errors fail closed without fallback, and preserves trailing Z/M ordinates
while recording `Z_NOT_TRANSFORMED`. All six operation input/output pairs now
come from committed canonical JSON Schema; the bridge no longer owns dynamic
runtime-only contract schemas. `crs.normalize.geometry@1.0` also remains shared
with the local Foundation identity adapter, so there is no second schema hash
for the same operation/version.

## Source state

```text
branch: codex/gowm-capability-platform-v0.2
base: origin/codex/unify-gowm-stas-v0.1.0@d1ff3b81b8bf577965b00edc1bd06acaaeda706c
local SHA before P06 commit: e100cc0fd0b7b27f8a386232dc2b261de7841547
remote SHA before P06 commit: e100cc0fd0b7b27f8a386232dc2b261de7841547
CRS source: isolated ZIP SHA-256 3110e7b344d138908d27e759ede70701b8a20dd7bbbd9795b3a57d02b8d70995
CRS OpenAPI: SHA-256 cd261d963c074394e01addeff32fad16dcdaef03bd2ae9f44dafae57ab9f6c06
CRS contract tree: SHA-256 9aa3e3415f1de2e4751dc428138f416c3da7057b7f6f7c3df4cad89b7b3b4e93
license: UNSPECIFIED; redistributionAllowed=false
```

## Key artifacts

- `services/providers/crs-provider-bridge/`
- `contracts/capabilities/crs.*/`
- `contracts/manifests/providers/crs-provider.json`
- `contracts/manifests/providers/crs-provider-source-lock.json`
- `validation/provider-conformance/crs/`
- `reports/capability-platform-v0.2/p06-crs-provider-acceptance.json`

No expanded POC source, package, native dependency, or image is tracked or
published. The extracted validation tree remains under ignored `.intake`.

## Tests actually run

| command | result | evidence |
|---|---|---|
| `npx.cmd vitest run --config validation/provider-conformance/crs/vitest.config.ts` | PASS | 1 file, 7 tests, 0 failures |
| `npx.cmd tsx scripts/sync-crs-contracts.ts --check` | PASS | Six schema pairs and provider manifest current |
| `node packages/platform/contract-runtime/scripts/generate-contract-types.mjs --check` | PASS | Generated runtime bundle/types/hashes current |
| `npm.cmd run check` | PASS | Root strict TypeScript and STAS typecheck |
| `npm.cmd run validate:boundaries` | PASS | `CAPABILITY_BOUNDARIES_PASS` |
| Git tracked/ignored intake checks | PASS | No `.intake` source tracked; expanded POC path ignored |
| `docker image inspect geospatial-crs-service:1.0.0` | NOT_RUN | Docker escalation rejected because execution approval quota was exhausted |

The scoped tests cover fixed route/operation parity, checked-in manifest and
source-lock parity, Provider SDK conformance, 3857 normalization, Z semantics,
strict provider-output validation, Grid fail-closed behavior, endpoint approval,
arbitrary-target denial, and Receipt/Compute Snapshot contents.

## Acceptance cases

- AC-030: **NOT_RUN** — hermetic 3857 contract path passes; required real POC
  process evidence is absent.
- AC-031: **PARTIAL** — fail-closed/no-fallback mapping passes; real EPSG:27700
  POC evidence is absent.
- AC-032: **PARTIAL** — Z preservation/warning passes against a
  protocol-faithful fixture; real POC evidence is absent.
- AC-033: **PASS** — malformed successful provider output fails
  `SCHEMA_MISMATCH`.
- AC-034: **PASS** — Receipt has input/output hashes and the required
  source/target/axis/version/artifact/policy attestations; the Compute Snapshot
  pins `proj.db`, offline Grid bundle, and integration package.
- AC-035: **PASS** — caller-selected targets and URLs are structurally absent
  and rejected as unknown input.
- AC-036: **PASS** — license remains unspecified, redistribution false, and no
  POC artifact is tracked.

## Security and ownership review

- The Gateway-to-Provider security context is validated by the shared SDK.
- CRS computation is world-independent caller data: it creates an Execution
  Receipt and Compute Snapshot, never a Data Snapshot or World Evidence.
- Upstream errors never echo geometry or coordinates in Platform Error details.
- Response redirects are forbidden; only HTTP(S) approved endpoints are
  accepted; user info, query, and fragment in the Registry endpoint are denied.
- Readiness compares the live engine/integration versions and hard policies to
  deployment attestation. Deployment must supply actual `proj.db` and Grid
  bundle versions and SHA-256 values before readiness can pass.
- The bridge has no provider-to-provider dependency beyond its single locked
  POC upstream and no impact on the local canonical ingest critical path.

## Failed attempts and blocker

The real POC image inspection/start path required Docker access outside the
sandbox. Automatic approval review rejected that command because the execution
approval quota was exhausted. Following the rejection, no alternate launch or
privilege workaround was attempted.

Therefore the implementation is complete and scoped conformance is green, but
P06 remains **PARTIAL** until a permitted run builds/starts the isolated ZIP,
extracts the live `proj.db` and Grid-bundle digests, and executes the 3857,
EPSG:27700 Grid-missing, and Z cases through the real process.

## Commit/push/PR

Not performed in this delegated slice. The root task owns the phase commit,
push, and Draft PR update.

## Next phase

Re-run real POC acceptance when Docker approval is available, then update
AC-030..032 and the deployment attestation with actual runtime evidence. P07
Geometry integration can proceed independently.
