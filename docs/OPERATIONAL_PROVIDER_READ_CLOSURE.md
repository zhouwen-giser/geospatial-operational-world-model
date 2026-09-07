# Operational Provider read closure (migration 076)

## Confirmed cause and boundary

The 2026-09-07 WSGS report reproduced `42501` in `operational-task.get`:
the task read used `gowm_operational_reality_v1`, but snapshot construction
subsequently selected `public.world_reference_identity` using the service login.
That login intentionally has no Foundation base-table SELECT. The source lookup
also directly selected Foundation/operational tables. Readiness did not inspect
these dependencies. Do not solve this with superuser credentials or base-table
grants.

Migration `076_operational_provider_read_closure.sql` adds two security-barrier
views under the existing read contract: `scope_identity` (opaque reference only)
and `world_source` (world-object reference and source only). Both filter through
the transaction-local authorized scope. Only the existing operational reader
role receives SELECT; PUBLIC receives none. Gateway scope authorization remains
mandatory: the database scope setter is a trusted-service selector, not a new
end-user authentication boundary.

The repository obtains scope identity with the data/digest in the same
REPEATABLE READ READ ONLY transaction. Source selection uses scoped task events
and the scoped world-source view; no raw observation payload is newly exposed.
Readiness tests the new views, snapshot function, scope-setter permission and
history read dependencies. Missing migration/permission returns 503.

Public operation/schema versions remain compatible. The implementation digest,
controlled registry hashes and method version (1.1, migration-076 artifact) change
so old execution identities are not reused. No MQTT mapper, inbox/session,
scheduler ownership or ingest contract changes are included.

## Retained-data upgrade

The GSAP deployment coordinator is the sole owner of shared-server changes.
This repair does not authorize database recreation, `down -v`, data replay or
production qualification. Back up the existing database and record its migration
ledger before upgrading. Verify the target is the intended existing Compose
project and volumes, with ledger through 075 and the expected old checksums.

Use the new package's existing `migrate` Compose service, whose entry point is
`node dist/scripts/migrate.js`. Build that service from the verified new archive;
run `docker compose <the existing env/file/project options> run --rm --no-deps migrate`
against the retained database. The placeholder options must come from the
coordinator's actual project, not from a new default project. Do not invoke a
rebuild/reset wrapper. The normal migration runner checks old checksums, appends
076 and also supports fresh initialization. It may perform its existing role and
index reconciliation; it is not a standalone permission-patch SQL command.

After successful migration, rebuild/recreate `operational-reality-provider` and
refresh the affected Grounding/World Platform Gateway controlled registry from
the same package. Preserve private configuration, transport tokens, static
Gateway authentication and all unrelated services. Assert readiness and execute
the real task through the signed Gateway before enabling consumers. On failure,
leave consumers stopped; keep the additive migration and evidence. No automatic
rollback to a previously broken package is provided.

## Regression and acceptance

`npm run validate:operational-read-closure` requires an isolated PostgreSQL server
via `DATABASE_ADMIN_URL`; it creates/drops only its own random test databases and
roles. It tests fresh 001–076 and retained-evidence 075→076, migration replay and
old checksums, real NOSUPERUSER login, HTTP ProviderRuntime get, timeline, sources,
scope isolation, base-table denial, scope reset and 503/200 readiness transitions.
Setup uses an admin connection; actual Provider reads use only the service role.
This gate is part of candidate CI. Existing frozen migration gates are not widened.

These isolated tests are not real WSGS business acceptance. The observed task
`wrf_4c6c3ea3ecb74bd0a45286469face58d@1` must be rerun by the coordinator.
`world.get-current-state INVALID_REQUEST` remains separately investigated.
MAP/STOP/CROSS/RANK were subsequently reported to stop at `operational-task.get`;
their successful downstream findings still require real execution after upgrade.
No changes to persisted correlation/predicate/observability analysis write paths
are asserted by this read-closure gate; any failures there require independent
request-level diagnosis, not a broader table grant.
