# Operational task reference search

Migration 084 maintains `OPERATIONAL_TASK` search rows during task projection, including unchanged snapshots. The task ID is a scope-bound external identifier owned by `gowm.operational-task/TASK_ID`. Reference keys and valid names remain catalog-derived. This does not change task facts, trajectory data, or device state.

Use an operator connection with migration 084 installed. The command requires an existing `DATABASE_ADMIN_URL` or `DATABASE_URL` and an explicit scope; it never prints identifiers or connection values.

```sh
node scripts/backfill-operational-task-references.mjs --scope default
node scripts/backfill-operational-task-references.mjs --scope default --apply
```

The first command previews task and missing-index counts in a read-only transaction. Apply processes only that scope, verifies key and task-ID rows, and rolls back on failure. Repeated application adds zero rows. The existing full catalog rebuild retains the registered task-ID external identifiers. Existing WSGS/GOWM HTTP schemas and reference validation remain unchanged.

Deploy migration and preview/apply the selected scope before deploying the WSGS task-type normalization. Verify both aliases through the public resolver and reference validator; do not equate a database row with a trusted reference. Rollback application code independently if needed; retain valid additive catalog records rather than deleting unrelated indexes or historical data.
