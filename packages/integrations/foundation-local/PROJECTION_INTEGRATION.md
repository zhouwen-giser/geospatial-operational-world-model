# ProjectionProcessor production integration

P05 is wired into `packages/runtime/src/projection.ts`. Canonical CRS identity,
Geometry validation, H3 R7-R10 projection, current-state writes, and all
successful Foundation receipts execute inside the same database transaction.
Any local validation, H3, or receipt-persistence failure aborts that transaction.

## Construction boundary

The H3 adapter is created from the `pg.PoolClient` already owned by
`withTransaction`. The CRS adapter is embedded and delegates Geometry validation
to the local GOWM spatial engine. Neither path constructs an HTTP client or adds
a Gateway fallback.

```ts
const h3 = new H3PgLocalAdapter(client, {
  h3PgVersion: verifiedH3PgVersion,
  receipts
});
```

`verifiedH3PgVersion` must come from deployment/startup attestation. Do not use
a placeholder digest. `engineDigest` is optional; when supplied it must be a
real `sha256:<64 lowercase hex>` digest.

The production seam should be a transaction-scoped factory so tests can inject
a fake without changing projection logic:

```ts
type H3AdapterFactory = (client: pg.PoolClient) => H3LocalAdapter;
```

## Exact projection call

`ProjectionProcessor` replaced its private inline `h3_latlng_to_cell` query with
this port call, kept inside the existing transaction:

```ts
const h3Execution = point
  ? await h3AdapterFactory(client).projectPoint({
      point: {
        longitude: point.coordinates[0],
        latitude: point.coordinates[1]
      }
    })
  : undefined;

const h3 = h3Execution
  ? {
      r7: requiredCell(h3Execution.result.cells, 7),
      r8: requiredCell(h3Execution.result.cells, 8),
      r9: requiredCell(h3Execution.result.cells, 9),
      r10: requiredCell(h3Execution.result.cells, 10)
    }
  : undefined;
```

`requiredCell` must throw if any requested resolution is absent. The adapter
already checks cell syntax, row ordinals, row count, and encoded resolution.
Its output is explicitly candidate-only; exact topology remains PostGIS-owned.

If local H3 execution or result validation fails, let the typed
`FoundationPortError` abort the transaction. Never keep a partial projection
and never attempt a remote fallback.

## Atomic receipt persistence

After `applyState` allocates `worldVersion`, and before the transaction commits,
the processor inserts the Geometry validation receipt, CRS identity receipt,
and (for Point geometry) H3 receipt plus their Compute Snapshots into the
`foundation_processing_receipt` table added by migration 012. This makes the
state change and its processing records atomic.

The parameterized insert copies, without recomputing, the receipt identity,
operation/provider/method fields, duration and hashes; the Compute Snapshot
policy/schema attestations; `observationId`; allocated `worldVersion`; changes,
warnings, details, and `generated_at`. The stage is one of
`GEOMETRY_VALIDATION`, `CRS_NORMALIZATION`, or `H3_INDEXING`; `projection_run_id`
remains `NULL` until the worker owns a persisted projection-run identifier.

The canonical local identity is `gowm.foundation-local@0.2.0`. Migration 012
checks that the duplicated columns agree with the embedded compute snapshot;
an inconsistency must fail the projection transaction.

Geometry is passed through `Canonical4326CrsNormalizationAdapter`, which calls
`GeometryValidationPort.assertValid`, before current projection. The normalized
clone is then used for state, events, geofencing, trajectory, and H3 projection.
A coordinate transformation is not part of this wiring: v0.2 accepts only
already-canonical `EPSG:4326` on the Foundation critical path and fails closed
for every other CRS.
