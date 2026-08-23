# P14 Compatibility and MCP split

Status: **implementation PASS; phase PARTIAL**

## Outcome

The v0.1 `/spatial/*` and `/situation/*` routes remain available. They now emit
`Deprecation`, `Sunset`, successor `Link`, warning and compatibility-mode
headers. Supported routes run through an explicit `LEGACY`, `DUAL_RUN` or
attested `GATEWAY` policy:

- `LEGACY` is the default and performs no Gateway call.
- `DUAL_RUN` executes legacy and Gateway paths, compares adapted result hashes
  and normalized semantic hashes, records parity evidence, and always returns
  the legacy result. A mismatch or Gateway failure never switches traffic.
- `GATEWAY` cuts over only a route carrying a versioned zero-mismatch parity
  attestation. Unattested or semantically unsupported routes continue on the
  legacy path.

No compatibility code contains a second SQL/H3 algorithm. Spatial requests map
only to fixed registered operations; legacy arbitrary filters, zero-width route
queries and other unmapped semantics remain on the old implementation.

## GOWM Situation Gateway boundary

A separate read-only `gowm.situation.h3` Provider owns four projection-query
operations:

- `gowm.situation.h3.get-cell`
- `gowm.situation.h3.get-area`
- `gowm.situation.h3.get-hotspots`
- `gowm.situation.h3.get-coverage-gaps`

Generic H3 Providers do not own World Version, risk, coverage or vehicle
metrics. The get-cell operation also accepts a bounded batch of H3 cells and
returns DB-grounded opaque `ReferenceKey` candidates for the H3 candidate to
Spatial exact-verification chain. Its output explicitly says
`candidateOnly=true` and `exactVerificationRequired=true`; no reference is
fabricated from an H3 index.

The Provider is `DATA_SCOPE_REQUIRED`, but the legacy `situation_cell` table is
not scope-keyed. Under the P14 prohibition on migration changes, the production
adapter therefore supports only a verifiable pinned single-scope deployment:
it checks before and after every legacy metric read that `data_scope` contains
exactly the configured scope. Multi-scope databases fail readiness and reads.
The candidate-reference query additionally applies an explicit
`object.data_scope_key = $1` predicate. **Arbitrary multi-scope Situation
serving remains BLOCKED and is not claimed as implemented.**

## MCP split

`world-query-mcp-readonly` exposes six fixed tools for nearby, in-area, area
situation, cell, hotspot and coverage-gap reads. All calls go through the
Capability Gateway, and there is no generic execute/discovery tool.

`observation-command-mcp` contains only the two Observation publishing tools
and sends them to Observation Ingest. The old combined MCP entrypoint is kept as
a deprecated compatibility surface until live parity is proved.

## Verification

| Command | Result |
|---|---|
| `npx.cmd vitest run tests/platform/compatibility-migration.test.ts` | **PASS**, 11/11 |
| `npm.cmd run test:platform` | **PASS**, 6 files / 42 tests |
| `npx.cmd vitest run tests/scenario/mcp.test.ts` | **PASS**, 1/1 legacy regression |
| `node packages/platform/contract-runtime/scripts/generate-contract-types.mjs --check` | **PASS** |
| `npm.cmd run check` | **PASS** |
| `npm.cmd run validate:boundaries` | **PASS**, `CAPABILITY_BOUNDARIES_PASS` |

## Acceptance status

- AC-081, AC-082 and AC-083: **PASS**.
- AC-079 and AC-080: **PARTIAL**. Unit/provider parity and safety behavior are
  proven, but a live old-route versus Gateway corpus was **NOT_RUN**.
- Multi-scope Situation Provider operation: **BLOCKED** by the unscoped legacy
  projection schema and the explicit no-migration P14 scope.

No commit or push was attempted due the parent-reported git-index quota
blocker. `package-lock.json`, migrations, P12/P13 ExecPlan and sync-state files
were not edited by P14.
