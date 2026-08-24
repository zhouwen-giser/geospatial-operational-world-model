# P08 H3 Bridge

Status: **implementation PASS; phase PARTIAL**

## Outcome

P08 now exposes two independent Provider Protocol bridges over the shared
Provider SDK:

- `gowm.h3.interactive.bridge` registers eight synchronous kernel operations
  with low-cost, 3 s default / 10 s maximum deadlines and interactive limits.
- `gowm.h3.analysis.bridge` registers three synchronous analytics operations
  with high-cost, 10 s default / 30 s maximum deadlines and separate analysis
  limits.

The allowlists are disjoint. Neither provider imports or calls another provider
or the capability gateway. Both are locked to H3 Spatial Toolkit 0.3.0 at Git
commit `74fc8657072dd58a2f8e4317c1caef8bfd10e024` and engine `h3-js` 4.5.0.
The external checkout was inspected read-only at that exact commit and remains
clean. No Toolkit or H3 algorithm source was copied into GOWM.

Six operations use only the locked Toolkit HTTP v1 routes. Cells-to-GeoJSON and
hierarchy/package-only operations use an explicit host-injected Toolkit package
interface whose startup attestation and Tokyo R9 self-check fail closed. GOWM
contains no second H3 implementation and the bridge source imports neither
`h3-js` nor `@h3-toolkit/*` directly.

## Contracts and semantics

Ten new strict input/output schema pairs were added under distinct
`contracts/capabilities/h3.*` namespaces; the existing canonical
`h3.index.points@1.0` pair is reused. Polygonal fields reference the stable
canonical Geometry schema. Generated types, bundle entries, and semantic
schema hashes are current and deterministic.

Cover and coverage results always report:

```text
CENTER_CONTAINMENT_COVER
candidateOnly=true
exactVerificationRequired=true
```

H3 is therefore a candidate generator, never the final boundary predicate.
Boundary-sensitive consumers must run exact Spatial/PostGIS verification.
Flow input retains distinct sequence arrays and output is marked
`SEQUENCE_ISOLATED`; the bridge never joins across an UNKNOWN MobilityDB gap.

The generic resolution profile is locked independently from the GOWM Situation
R7-R10 profile. Generic results are caller-data-bound and cannot fabricate a
Data Snapshot, World Evidence, `worldVersion`, or Situation metric profile.
Provider deadlines, endpoint approval, redirects, input/output schemas,
upstream Toolkit/engine attestation, output bytes, cells, candidates, rows,
vertices, batch size and neighbor radius all fail closed. Oversized
cover/coverage/flow requests are rejected synchronously; async execution is not
advertised.

## Source, license, and supply chain

The source lock records Apache-2.0 as approved, preserves a third-party notice
and Apache license text, and includes a CycloneDX SBOM linking the immutable
Toolkit source and `h3-js` 4.5.0. The tracked lock explicitly records
`sourceCopiedIntoGowm=false`.

Key artifacts:

- `contracts/capabilities/h3.*/`
- `contracts/manifests/providers/h3-toolkit-source-lock.json`
- `contracts/manifests/providers/h3-interactive-provider.json`
- `contracts/manifests/providers/h3-analysis-provider.json`
- `packages/integrations/h3-toolkit-bridge/`
- `services/providers/h3-interactive-provider/`
- `services/providers/h3-analysis-provider/`
- `validation/h3-bridge/`
- `reports/capability-platform-v0.2/p08-h3-bridge-acceptance.json`

## Verification actually run

| command | result | evidence |
|---|---|---|
| External checkout `rev-parse HEAD` and `status --short` | PASS | Exact required SHA; no checkout modifications |
| `node packages/platform/contract-runtime/scripts/generate-contract-types.mjs --check` | PASS | Generated H3 schemas/types/hashes are deterministic |
| Four bridge/validation/service `tsc --noEmit` commands | PASS | Integration, validation, interactive service and analysis service compile independently |
| `npx.cmd vitest run --config validation/h3-bridge/vitest.config.ts --reporter verbose` | PASS | 1 file, 13 tests, 0 failures |
| `npm.cmd run check` | PASS | Root TypeScript and STAS typecheck |
| `npm.cmd run validate:boundaries` | PASS | `CAPABILITY_BOUNDARIES_PASS` |
| `npm.cmd test` | PASS | 14 files passed, 1 skipped; 58 tests passed, 1 skipped |
| Real Toolkit API E2E harness | BLOCKED | `http://127.0.0.1:3000` readiness failed with `fetch failed` |
| Real `h3-js` / `h3-pg` golden harness | BLOCKED | PostgreSQL reached, then SQLSTATE `28P01` for unavailable isolated credential |

The 13 scoped tests cover exact source/manifests, disjoint QoS and allowlists,
cover semantics, no invented World state/evidence, generic resolution,
fail-closed source attestation, all six locked HTTP routes, package-only
GeoJSON/hierarchy/neighborhood delegation, strict output drift, sequence gap
isolation, large-job/radius rejection, shared SDK conformance, Provider Protocol
HTTP routes, and Apache/SBOM/no-source-copy boundaries.

## Acceptance

- AC-045: **BLOCKED** — the read-only golden harness covers Tokyo, Beijing and
  antimeridian points, but real DB parity cannot run without the isolated
  PostgreSQL credential.
- AC-046: **BLOCKED** — the same harness covers parent, children and radius-one
  neighbor parity, but stops at SQLSTATE `28P01` before queries execute.
- AC-047: **PASS** — schema and bridge output lock center-containment candidate
  semantics and mandatory exact verification.
- AC-048: **PARTIAL** — the bridge enforces the exact-verification handoff, but
  the real Spatial/PostGIS cross-provider E2E was not run.
- AC-049: **PASS** — generic named resolutions and Situation R7-R10 remain
  separate policies.
- AC-050: **PASS** — strict generic outputs reject a fabricated
  `worldVersion`; no Data Snapshot or evidence is emitted.
- AC-051: **NOT_RUN** — real Situation world-version/metric-profile integration
  belongs to P09/P14 and is not claimed by these generic providers.
- AC-052: **PARTIAL** — sequence-isolated contract/unit evidence passes; real
  Toolkit/MobilityDB flow E2E is blocked with the Toolkit API unavailable.
- AC-053: **PASS** — cover, coverage and flow exceedances fail with a typed
  budget error; sync-only manifests do not pretend to support jobs.
- AC-054: **PASS** — provider IDs, allowlists, deadlines, cost classes, limits,
  bodies and health processes are independent.
- AC-055: **PASS** — Apache-2.0 notice, license text, immutable source lock and
  SBOM attribution are retained.

## Real-runtime residuals

The exact immutable Toolkit checkout contains no installed dependencies and no
Toolkit API was running at the approved local endpoint. No source/dependency
copy or substitute service was used. PostgreSQL on port 55490 is reachable, but
the available `gowm` credential is rejected with SQLSTATE `28P01`; no parity SQL
ran. Per root coordination, Docker was not invoked.

Consequently implementation and scoped conformance are complete, while P08
remains **PARTIAL** until the real Toolkit API, H3 4.5 PostgreSQL parity, exact
Spatial/PostGIS boundary verification, and MobilityDB gap E2E can be executed
with approved runtime access.

## Commit/push/PR

Not performed in this delegated slice. The root task owns commit, push and Draft
PR publication.
