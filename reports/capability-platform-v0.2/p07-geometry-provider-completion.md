# P07 Geometry Provider Bridge

Status: **implementation PASS; phase PARTIAL**

## Scope completed

The original GOWM Geometry Provider Bridge is implemented over the shared
Provider SDK and canonical contract runtime. It exposes exactly 19 independent,
schema-locked operation descriptors and uses one fixed upstream execution route:
`POST /v1/geometry/execute`. The request cannot select a URL, path, provider, or
unregistered operation. Readiness uses only `GET /ready` and fails closed unless
the attested `GEOS-WASM-WORKER-POOL` has ready, bounded workers.

All operation inputs and outputs are strict JSON Schema 2020-12 contracts.
Eighteen new operation pairs reuse the GOWM Geometry Provider definitions; the
pre-existing canonical `geometry.validate@1.0` contract remains unchanged. The
shared deterministic generator was run only after the concurrent H3 schema set
converged, so the committed generated types, bundle, and hashes contain both
sets without duplicate schema IDs.

Validation is immutable and always sends `mode=strict` and
`repairInvalid=false`. Explicit `geometry.make-valid` is the only registered
repair path. Binary operations reject different coordinate spaces or layouts
before an upstream call. Buffer distance and precision/tolerance parameters are
declared only in coordinate-space units; `EPSG:4326` buffer requires explicit
planar acknowledgement and is reported as angular degrees, never as a metre
unit.

The bridge adds a bounded in-flight/queue admission gate without bypassing the
POC's own worker pool. Queue saturation maps to retryable `OVERLOADED`; POC
worker timeout maps to retryable `DEADLINE_EXCEEDED`; body/vertex limits,
deadline cancellation, schema locks, malformed upstream output, and endpoint
approval all fail closed.

## Receipt and snapshot provenance

The shared SDK generates canonical input/output hashes, result hash, compute
snapshot hash, schema hashes, duration and provider identity. Geometry adds:

- repair applied and geometry input/output type change;
- precision grid or explicit floating precision;
- coordinate space and unit semantics;
- GEOS worker-pool engine/version;
- geos-wasm integration/version;
- locked source ZIP/OpenAPI digests;
- explicit make-valid marker and concrete predicate where applicable.

No Data Snapshot or World Evidence is fabricated because these are caller-data
computations.

## Source and license lock

```text
branch: codex/gowm-capability-platform-v0.2
local SHA observed during P07: e100cc0fd0b7b27f8a386232dc2b261de7841547
Geometry source ZIP SHA-256: 3527a06d7a6216c1bf1c2ee75690824298231917c03a8c99507a71df26f12c3d
Geometry OpenAPI SHA-256: f45ad64ab0781289e960e826dde220db85c295d45d2d69e4f1afbf163e7cd600
engine: GEOS-WASM-WORKER-POOL 3.13.0-CAPI-1.19.0
integration: geos-wasm 3.1.1
license: UNSPECIFIED; redistributionAllowed=false
```

The ZIP was expanded only under ignored
`.intake/providers/geometry-tool-service-v1.0/geometry-tool-service`. Git tracks
no `.intake` file. No POC source, package, dependency tree, or image was copied
into the repository. The tracked source lock permits only the original GOWM
bridge, manifests, tests, and evidence.

## Key artifacts

- `services/providers/geometry-provider-bridge/`
- `services/providers/geometry-provider-bridge/manifests/operation-registration.json`
- `contracts/manifests/providers/geometry-provider.json`
- `contracts/manifests/providers/geometry-provider-source-lock.json`
- `contracts/capabilities/geometry-provider/definitions.schema.json`
- `contracts/capabilities/geometry.*/{input,output}-1.0.schema.json`
- `tests/platform/geometry-provider-bridge.test.ts`
- `reports/capability-platform-v0.2/p07-geometry-provider-acceptance.json`

## Tests actually run

| command | result | evidence |
|---|---|---|
| `Get-FileHash` for locked Geometry ZIP and extracted OpenAPI | PASS | Exact expected SHA-256 values above |
| `node packages/platform/contract-runtime/scripts/generate-contract-types.mjs --check` | PASS | Generated bundle/types/hashes deterministic after Geometry + H3 convergence |
| `npx.cmd tsc -p services/providers/geometry-provider-bridge/tsconfig.json --noEmit` | PASS | Strict bridge compilation |
| `npx.cmd vitest run tests/platform/geometry-provider-bridge.test.ts --reporter verbose` | PASS | 1 file, 12 tests, 0 failures |
| `npx.cmd vitest run --config validation/gateway-contract/vitest.config.ts` | PASS | 1 file, 15 tests, 0 failures |
| `npm.cmd run test:platform` | PASS | 5 files, 28 tests, 0 failures |
| `npm.cmd run check` | PASS | Root strict TypeScript and STAS typecheck |
| `npm.cmd run validate:boundaries` | PASS | `CAPABILITY_BOUNDARIES_PASS` |
| Git tracked/ignored intake checks | PASS | Expanded POC ignored and untracked |
| `npm.cmd ci --ignore-scripts --no-audit --no-fund` inside isolated POC | BLOCKED | Sandbox `EPERM`; controlled escalation rejected because execution approval quota was exhausted |

The 12 scoped tests cover all 19 operation mappings, runtime/static manifest
parity, source/license locks, immutable validation, no implicit repair,
make-valid receipt type changes, the EPSG:4326 unit guard, same-coordinate-space
enforcement, worker-timeout mapping/recovery, strict upstream schema rejection,
bounded overload/drain behavior, Provider SDK conformance, and readiness.

## Acceptance

- AC-037: **PARTIAL** — immutable bridge behavior passes; real-provider run is blocked.
- AC-038: **PARTIAL** — repair is limited to explicit make-valid in the bridge; real-provider run is blocked.
- AC-039: **PASS** — canonical receipt records repair and Polygon-to-MultiPolygon type change.
- AC-040: **PASS** — EPSG:4326 buffer 1000 is angular coordinate-space degrees, not a metre unit.
- AC-041: **PARTIAL** — retryable timeout mapping and subsequent recovery pass; current real worker termination/replacement proof is blocked.
- AC-042: **PARTIAL** — bounded bridge queue overload/drain passes; current real upstream queue proof is blocked.
- AC-043: **PASS** — all required boundary operations are unregistered.
- AC-044: **PASS** — license/source/package/image publication boundary is enforced.

## Real POC blocker

The extracted immutable POC contains built outputs but no `node_modules`.
Installing the lockfile dependencies under the ignored intake tree first failed
inside the sandbox with `EPERM` while creating `node_modules`. The required
controlled escalation was then rejected because the execution approval quota
was exhausted. No alternate execution, dependency-copy, source-copy, or
privilege workaround was attempted.

Consequently, bridge implementation and scoped conformance are complete, but
P07 remains **PARTIAL** because AC-037, AC-038, AC-041 and AC-042 are explicitly
classified as real-provider cases and cannot truthfully be closed by fixtures.

## Commit/push/PR

Not performed in this delegated slice. The root task owns the phase commit,
push, and Draft PR update.

## Follow-up needed to close P07

When controlled execution is available, install the immutable lockfile only in
the ignored intake workspace, start the real worker-pool API, point the bridge
at its approved local endpoint, and rerun validate immutability, explicit
make-valid, forced worker timeout/replacement/recovery, and queue saturation.
