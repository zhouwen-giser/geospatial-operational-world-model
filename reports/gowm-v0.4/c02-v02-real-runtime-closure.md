# C02 v0.2 Real Runtime Closure

## Decision

`BLOCKED_EXTERNAL`

All runnable v0.2 database, H3, Gateway, Spatial, Situation, scope, restart,
idempotency, and repository verification gates passed. The exact locked CRS,
Geometry, Spatial POC archives and H3 Toolkit source revision required by
AC-C007/AC-C008 are not present in the repository, operator download set, or
local runtime images. The missing third-party inputs were not reimplemented or
substituted, so the two exact Provider/DAG gates remain blocked honestly.

The verified C02 runtime fixes are committed and pushed at
`698fc77918a73ae7675b1df34efdc744ea202738`. Migrations 001–014 were not
modified; both repairs are append-only migrations 015 and 016.

## Real-runtime findings and repairs

The first live Gateway worker cycle exposed an ambiguous PL/pgSQL output name
inside `claim_world_query_job`: `RETURNING job_id` collided with the
`RETURNS TABLE` output parameter. Migration 015 fully qualifies the transition
identifier and adds an executable empty-queue assertion.

The first durable Registry sync then exposed a contract drift: the database
port validator rejected the canonical CapabilityDescriptor's optional JSON
Pointer `path`. Migration 016 permits only a schema-valid RFC 6901-style path,
retains the strict field allow-list, restores the runtime/admin ACL, and adds
positive and negative SQL assertions. After both append-only fixes the worker
became quiet, all six manifests synchronized, and real Gateway calls completed.

## Evidence classification

### Real evidence

- Isolated PostgreSQL 18.6 with PostGIS 3.6.4, MobilityDB 1.3.0, h3 and
  h3_postgis 4.5.0.
- Fresh install through migration 016, checksum-verified repeat execution, and
  historical v0.1 (001–010) upgrade through 011–016.
- All six SQL assertion files on fresh, upgraded, primary, and restarted
  databases.
- Live h3-js 4.5.0 / h3-pg 4.5.0 point, hierarchy, neighborhood, polygon,
  index, and projection parity.
- Least-privilege Registry bootstrap persisted six approved Providers and 50
  operations.
- Live Gateway → Situation Provider → PostgreSQL returned an honest `NO_DATA`
  envelope and replayed the identical request from durable storage.
- Live Gateway → Spatial Provider → `gowm_spatial_v1` returned `COMPLETED`
  under a repeatable-read, read-only transaction.
- A public body attempting to inject `dataScopeClaim` was rejected with 422
  `INVALID_REQUEST` before routing; SQL scope/role assertions also passed.
- A bounded Gateway stop/start preserved the completed Spatial result:
  `Idempotent-Replay` changed from `false` before restart to `true` after it.
- PostgreSQL restart recovered healthy, both live Providers reconnected, and
  all SQL assertions passed again.

### Controlled evidence

- Runtime acceptance: 28/28 tests passed.
- Real-database opt-in integration: 1/1 passed.
- Full repository verification passed: SQL AST for migrations 001–016 and all
  assertions, 79 root tests with one declared skip, 39 STAS tests, typechecks,
  and builds.

### Externally blocked evidence

The following immutable inputs named by
`dependencies/V02_EXTERNAL_RUNTIME_PREREQUISITES.md` are absent:

- CRS ZIP SHA-256 `3110e7b344d138908d27e759ede70701b8a20dd7bbbd9795b3a57d02b8d70995`;
- Geometry ZIP SHA-256 `3527a06d7a6216c1bf1c2ee75690824298231917c03a8c99507a71df26f12c3d`;
- Spatial ZIP SHA-256 `15cdaf00f3c5ee911eac1351c2d9a59ff06a5de93a176ce81b644b19ee5de322`;
- H3 Toolkit revision `74fc8657072dd58a2f8e4317c1caef8bfd10e024`.

Therefore the exact CRS→Spatial, CRS→Geometry→Spatial, and
CRS→Geometry→H3→Spatial DAGs were not claimed as real-runtime passes.

## Acceptance

- AC-C005: PASS — fresh install and repeat migration execution passed through
  016; locked 001–014 hashes remain unchanged.
- AC-C006: PASS — historical v0.1 upgraded through 016 and all assertions
  passed without changing 001–014.
- AC-C007: BLOCKED_EXTERNAL — exact locked prior Provider inputs are absent.
- AC-C008: BLOCKED_EXTERNAL — exact cross-capability DAGs require those inputs.
- AC-C009: PASS — transport-derived scope resisted public injection and real
  database scope/role assertions passed.
- AC-C010: PASS for the available runtime — Gateway, Spatial/Situation Provider,
  and database restart/recovery paths passed; this does not promote AC-C007 or
  AC-C008.
- AC-C012: PASS — PR #1 remains Draft and user-controlled; no merge, tag,
  release, or deployment was performed.

## Handoff

C03 may start the stacked continuation from the exact pushed v0.2 candidate.
The external C02 blocker must remain visible in every later phase and final
report; it may only be cleared by supplying and verifying the immutable prior
inputs.
