# P05 Foundation local ports

Status: **implementation PASS; phase PARTIAL**

## Outcome

The Foundation now has typed local interfaces for Geometry validation, canonical
CRS handling, H3 indexing/projection, clocks, IDs, deterministic canonical
hashing, and canonical processing receipts. Production adapters have no HTTP,
Gateway, or Provider-client dependency.

- Geometry wraps the existing `validateGeometry` implementation. Invalid
  geometry is rejected, never repaired, and never mutated.
- CRS accepts only already-canonical `EPSG:4326` geometry and emits explicit
  identity-transformation provenance (`GOWM@0.2.0`, `foundation-local@0.2.0`,
  strict/offline/no-cache). Any transformation request fails closed with the
  licensing/distribution blocker recorded in the typed error; there is no
  remote fallback.
- H3 executes static parameterized SQL through the transaction-local
  `pg.PoolClient` shape. Results are candidate indexes and name PostGIS as the
  exact spatial authority.
- Receipts use P01-generated `ExecutionReceipt` and `ComputeSnapshotContext`
  types, validate against the canonical schemas, record real generated operation
  schema hashes, and reject schema drift.
- Production `ProjectionProcessor` now runs canonical CRS identity (which
  performs Geometry validation) before state mutation, runs local H3 R7-R10 for
  Point geometry, and persists Geometry, CRS, and H3 receipts in the same
  transaction as the allocated World Version and current projection.

## Key artifacts

- `packages/platform/foundation-ports/`
- `packages/integrations/foundation-local/`
- `packages/integrations/foundation-local/PROJECTION_INTEGRATION.md`
- `validation/foundation-ports/`
- `reports/capability-platform-v0.2/p05-foundation-local-ports-acceptance.json`

## Verification

- Scoped Foundation tests: **17/17 PASS**.
- Scoped strict TypeScript: **PASS**.
- Capability boundary validator: **PASS**.
- Root `npm run check`: **PASS**, including the production ProjectionProcessor
  integration.
- A controlled runtime integration test invokes the real `ProjectionProcessor`
  with a transaction-shaped client, proves invalid Geometry fails before any
  current-state mutation query, and observes transaction rollback.
- Live local h3-pg check: **BLOCKED** after reaching PostgreSQL on port 55490;
  authentication failed (`28P01`) and the isolated-stack credential was not
  available. No database write was attempted.

## Production integration

`packages/runtime/src/projection.ts` is the production wiring. It has injectable
local adapter seams, no Gateway or remote Provider fallback, uses the normalized
Geometry for state/events/geofencing/trajectory, and persists all successful
Foundation receipts after World Version allocation and before commit.
`PROJECTION_INTEGRATION.md` records the exact boundary and failure semantics.

## Residuals

- Prove the migration-012 receipt inserts against live PostgreSQL.
- Re-run the read-only real h3-pg check with the isolated-stack credential.
- Run the live remote-outage fault test.
- Run real local h3-pg/remote Toolkit Golden Parity in P08.

These real-environment residuals keep P05 `PARTIAL`; they do not weaken the
completed production wiring or its controlled integration evidence.
