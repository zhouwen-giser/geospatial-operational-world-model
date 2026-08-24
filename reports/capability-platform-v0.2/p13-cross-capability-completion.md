# P13 Cross-capability World Query DAG completion

Status: **PARTIAL**

The required World Query DAG chains now execute through the actual in-tree
Provider Runtimes and Gateway orchestration. Their external dependencies are
controlled in-process fixtures, so this phase records the scoped tests as PASS
without promoting them to real external-service or real-PostgreSQL evidence.

## Implemented chains

- `CRS Point -> Spatial Nearby`
- `CRS Polygon -> Geometry Validate -> Spatial In-Area`
- invalid polygon validation with a guarded downstream Spatial node
- `Validate -> explicit MakeValid -> Validate -> Spatial In-Area`
- `CRS Polygon -> Geometry Validate -> H3 Cover -> GOWM H3 Situation candidates -> Spatial Exact Intersections`
- separated tracklet sequences into `H3 Flow` with `SEQUENCE_ISOLATED` gap policy

The harness registers the CRS, Geometry, H3 interactive, H3 analysis, GOWM
Situation, and Spatial manifests in the controlled Capability Registry. Every
node uses the Registry descriptor's real operation version and generated input
and output schema hashes.

## Acceptance evidence

| Row | Controlled runtime result | Real service result | Key proof |
| --- | --- | --- | --- |
| AC-071 | PASS | NOT_RUN | Normalized point reaches parameterized `ST_DWithin`; DataScope is `default` |
| AC-072 | PASS | NOT_RUN | immutable `valid=true` precedes exact `ST_Covers` |
| AC-073 | PASS | NOT_RUN | `valid=false` skips Spatial at attempt 0; no Spatial operation SQL is issued |
| AC-074 | PASS | NOT_RUN | CRS `/geometry` binds directly to MakeValid `/input/geometry`; explicit typed literals supply coordinate space/layout; repair, type change, and revalidation are recorded |
| AC-075 | PASS | NOT_RUN | H3 remains candidate-only; scoped Situation returns two world ReferenceKeys; parameterized Spatial `ST_Intersects` filters them to one exact result |
| Tracklet to H3 Flow | PASS | NOT_RUN | the Toolkit boundary receives two separate trajectory arrays across the UNKNOWN gap |

AC-074 now uses the bounded nested `targetPath` binding in the canonical World
Query v2 contract. The exact repair DAG is:

```text
CRS Normalize Geometry /geometry
  -> Geometry Validate (valid=false guard)
  -> Geometry MakeValid /input/geometry
       + literal EPSG:4326 -> /input/coordinateSpace
       + literal XY        -> /input/coordinateLayout
  -> Geometry Validate (valid=true guard)
  -> Spatial In-Area
```

There is no request-side `repairOperand`. Every leaf retains a canonical schema
and typed port, and the Provider Runtime validates the fully assembled request
against the strict `geometry.make-valid` input schema before execution.

The target-path implementation is deliberately narrow. A path must be a rooted
JSON Pointer, cannot exceed eight object segments, and is accepted only on
composite node inputs. Whole-request bindings, preconditions, and query outputs
cannot use it. Duplicate paths, ancestor/descendant collisions, and decoded
`__proto__`, `prototype`, or `constructor` segments fail before provider
execution. Runtime construction uses object-only null-prototype containers and
rejects assignment collisions.

AC-075 keeps the semantic boundary visible in the returned envelopes:

- generic H3 has a Compute Snapshot and Receipt, but no Data Snapshot or World
  Evidence;
- GOWM Situation has a `BEST_EFFORT` Data Snapshot and produces candidate
  ReferenceKeys from the controlled world-data read port, not from H3 cell text;
- Spatial performs the exact PostGIS predicate and returns a
  `CONSISTENT_AT_START` Data Snapshot plus current-projection Evidence;
- no Receipt is treated as Evidence, and no H3 candidate result is labelled
  exact.

## Verification

```text
npx.cmd tsc -p validation\cross-capability\tsconfig.json --noEmit
PASS (exit 0 after the concurrent P16 streaming-client edit stabilized)

npx.cmd vitest run --config validation\cross-capability\vitest.config.ts
PASS: 1 file, 6 tests, 0 failures

npx.cmd vitest run tests/platform/world-query-runtime.test.ts
PASS: 1 file, 12 tests, 0 failures

node packages/platform/contract-runtime/scripts/generate-contract-types.mjs --check
PASS: generated contracts and schema hashes are current

npx.cmd vitest run tests/platform/canonical-hash.test.ts
PASS: 1 file, 2 canonical contract/hash tests, 0 failures

npm.cmd run test:platform
PASS: 6 files, 47 tests, 0 failures

npm.cmd run check
PASS: root TypeScript and STAS TypeScript checks exited 0

npm.cmd run validate:boundaries
PASS: CAPABILITY_BOUNDARIES_PASS
```

The scoped tests also assert that every completed DAG node retains input and
output hashes plus a Compute Snapshot.

## Truthful external status

The full chain was not run against real external CRS, Geometry, or H3 Toolkit
processes. Real PostgreSQL Spatial execution is blocked: the available lab port
rejected the known credentials with SQLSTATE `28P01`, while Docker escalation
is unavailable under the current execution-platform usage limit. Git staging,
commit, and push remain blocked by the same platform limit and were not
attempted in this P13 subtask.

Accordingly, AC-071 through AC-075 and the tracklet flow are **PARTIAL** at the
release-evidence level even though their controlled Provider Runtime suites
pass. P12 remains the source of evidence for AC-069, AC-070, AC-076, AC-077,
and the partial AC-078 persistence/restart row.

## Artifacts

- `contracts/platform/world-query-plan-v2.schema.json`
- `contracts/capabilities/geometry/coordinate-space.schema.json`
- `contracts/capabilities/geometry/coordinate-layout.schema.json`
- `packages/platform/contract-runtime/src/semantic-validation.ts`
- `packages/platform/contract-runtime/src/generated/{contracts,schema-bundle,schema-hashes}.ts`
- `services/gateway/world-capability-gateway/src/query-plan-validation.ts`
- `services/gateway/world-capability-gateway/src/query-plan-runtime.ts`
- `tests/platform/world-query-runtime.test.ts`
- `validation/cross-capability/fixtures.ts`
- `validation/cross-capability/world-query-dag.test.ts`
- `validation/cross-capability/tsconfig.json`
- `validation/cross-capability/vitest.config.ts`
- `reports/capability-platform-v0.2/p12-world-query-runtime-acceptance.json`
- `reports/capability-platform-v0.2/p12-world-query-runtime-completion.md`
- `reports/capability-platform-v0.2/p13-cross-capability-acceptance.json`
- `reports/capability-platform-v0.2/p13-cross-capability-completion.md`
