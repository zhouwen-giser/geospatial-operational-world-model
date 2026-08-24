# Capability Platform v0.2 database boundary

Migrations `011_capability_gateway_persistence.sql` and
`012_gowm_spatial_v1_read_contract.sql` are append-only additions after the
immutable GOWM+ `001`-`010` history.

## Ownership

- `gowm_capability` is Gateway-owned operational metadata. It stores approved
  provider routes, operation versions, health observations, jobs,
  idempotency leases/results, receipts, evidence references, circuit state,
  and low-cardinality audit events. It has no foreign keys to Foundation fact
  tables.
- `world_reference_identity` is Foundation-owned. Its opaque reference keys
  are append-only and retain identity after a canonical object is retired.
  Contract views wrap the opaque ID in the canonical structured ReferenceKey
  (`namespace`, `kind`, `id`, `version`) for version-aware API use.
- `foundation_processing_receipt` is Foundation-owned and append-only. It
  records embedded/local ingest and projection methods without any dependency
  on the Gateway registry; observation and projection-run links are optional.
- `gowm_spatial_v1` is a read-only provider contract. It exposes current
  objects/geometries, latest layer features, and a current-projection dataset
  descriptor without exposing internal object identifiers.

`gowm_gateway_runtime` can read approved registry data and mutate only the
Gateway operational tables required at runtime. Receipt, evidence, health,
transition, and audit histories reject updates and deletes.

`gowm_gateway_registry_admin` is the separate controlled-configuration role
that can register and approve providers/capabilities. The runtime role cannot
modify provider routes or approvals, and the registry role cannot write jobs,
receipts, or audit history. `display_name` is a deployment-owned catalog label,
not a value trusted from a provider manifest.

`spatial_provider` has `SELECT` only on the four versioned contract views. It
has no privileges on Foundation base tables or the reference identity table.
The role defaults to read-only transactions with a five-second statement
timeout and a one-second lock timeout.

## Spatial transaction protocol

The provider must begin a read-only transaction, establish its independently
validated scope, and then query only the contract views:

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT gowm_spatial_v1.set_data_scope(:trusted_scope_key);
SELECT * FROM gowm_spatial_v1.current_object WHERE reference_key = :reference_key;
COMMIT;
```

The scope setting is transaction-local. Every contract view filters on that
setting, so an absent or different scope produces no cross-scope rows. The
setter deliberately returns a generic error for an unavailable scope.

Current-projection reads declare `CONSISTENT_AT_START`. They must not be
reported as a pinned historical world version. Versioned layer rows may cite
their actual `layer_version`.

## Idempotency restart protocol

Call `gowm_capability.claim_idempotency(...)` inside the request transaction.
It serializes callers with a row lock and returns one of:

- `CLAIMED_NEW`: execute the request under the returned lease;
- `IN_PROGRESS`: another live Gateway owns the lease;
- `CLAIMED_RECOVERED`: the prior process lease expired and this caller now
  owns recovery;
- `REPLAY`: return the persisted `result_envelope` and receipt without
  re-executing the provider;
- `FAILED`: replay the persisted terminal failure policy.

A key reused with a different request hash is rejected. `COMPLETED` rows must
contain both a receipt and result envelope; `IN_PROGRESS` rows cannot contain
either and must have a live-or-expired lease owner/time pair.

## Verification

After applying migrations through the normal checksum-enforcing runner, run:

```text
psql -v ON_ERROR_STOP=1 -f database/tests/002_capability_gateway_assertions.sql
psql -v ON_ERROR_STOP=1 -f database/tests/003_gowm_spatial_v1_assertions.sql
psql -v ON_ERROR_STOP=1 -f database/tests/004_foundation_processing_receipt_assertions.sql
```

Both files wrap test records in a transaction and end with `ROLLBACK`; they do
not seed or retain canonical data.

## Reversal policy

This repository has no executable down-migration convention. Do not delete or
rewrite an applied migration and do not downgrade a shared or evidence-bearing
database in place. For a disposable development database, restore the snapshot
taken before `011`, or drop the v0.2 objects in reverse dependency order only
after confirming there are no receipts, audit records, reference identities,
or consumers. Production reversal is restore/forward-fix only because deleting
append-only receipts or public identities would destroy evidence and API
continuity.
