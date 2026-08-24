# P00 Network Provider Completion

## Scope completed

Implemented the deployable `gowm.network` Provider with the frozen 11-operation manifest. Every operation executes through a fixed `gowm_network_v1` query, after transaction-local DataScope/DatasetScope is established in a `REPEATABLE READ READ ONLY` transaction. The Provider does not accept table, schema, SQL, or algorithm selection from the caller.

The runtime supports directed snapping, deterministic partial-arc routing, bounded cost matrices, Pairwise and Multi-edge Turn restrictions through product-state history, condition/profile filtering, expansion validation, connectivity/reachability diagnostics, and an independent path verifier. Deadline and segment limits fail closed.

The v0.5 task package locks raw Schema file bytes, while the shared SDK historically locked canonical JSON. P00 extends the SDK operation record with explicit source-byte lock hashes; runtime validation still uses the frozen Schema object, and a test independently hashes every referenced file before comparing it to the Manifest.

## Tests actually run

| command | result | evidence |
|---|---|---|
| `npx vitest run tests/platform/network-provider.test.ts tests/platform/provider-sdk-deadline.test.ts` | PASS | 5 tests |
| `npm run check` | PASS | generated contracts, TypeScript, STAS typecheck |
| `npm run verify` | PASS | 159 Vitest PASS, 1 explicit skip; 39 STAS PASS; 43 migration and 28 assertion AST PASS; build PASS |

Unit evidence covers exact start/end fractions, directed matrix reachability, Pairwise forbidden turns, Multi-edge forbidden sequences, exactly-once penalties, and independent continuity/turn/metric/hash mutation detection.

## Acceptance truth

- `AC-P001`: PASS — exact frozen operation order, versions, maturity, execution mode and raw Schema file hashes.
- `AC-P002..AC-P020`: `NOT_RUN` — these rows explicitly require real E2E, resource, differential, or recovery evidence and are owned by P01.

## Blockers

None for P00.

## Next phase

P01 real PostgreSQL/pgRouting Provider acceptance, including scope isolation and restart recovery.
