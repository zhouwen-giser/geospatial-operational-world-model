# Native WORLD_OBJECT reference catalog repair

Migration 077 fixes identities created after the one-time migration 017 catalog
backfill: identity existence alone previously allowed an opaque `SCOPE_DENIED`
from `reference.get` when its descriptor was missing. This is not solved by
granting the Provider access to Foundation tables.

## Version and growth contract

New native objects are projected after their initial state exists. Metadata
changes append immutable descriptor/name evidence only when type, subtype or
display label changes. Position/state updates do not append catalog rows.
The current native reference version is the authoritative state version;
`reference.get`, scoped identity and platform validation agree. Normal metadata
writes must use WorldRepository's transactional state-version increment, not
direct SQL that changes metadata without advancing state. The descriptor version
remains a separate metadata identity; snapshot identity includes both descriptor
and state version maxima. Prior references become STALE when state advances.

Existing externally authored descriptors keep their authority and version
semantics. No old descriptors, names, object states, observations, references or
published migrations are rewritten. Superseded native names remain immutable
evidence but are excluded from current name reads and rebuilt search projections.
An actual nonempty object `properties.name` is a canonical name. Otherwise an
explicit `Unnamed WORLD_OBJECT [opaque reference]` display label is used, never
an invented vehicle identity or alias.

## Controlled existing-object repair

Migration does not scan/backfill existing objects. A designated operator must
review an explicit Scope and JSON array of opaque reference IDs (maximum 1000).
Use a dedicated login inheriting `gowm_reference_catalog_operator`, not a Provider
or administrator connection. This is an explicitly cross-Scope maintenance role:
only grant it to authorized maintenance operators. It has scoped planning/apply
function execution, no base-table write grants. PUBLIC execution is revoked.

Source checkout (with installed locked dependencies):

```sh
npm run reference:catalog-backfill -- --scope "$SCOPE" --references "$REFERENCE_LIST"
```

Verified deployment image (no host node_modules required):

```sh
docker run --rm --network "$REVIEWED_DATABASE_NETWORK" \
  --env-file "$PRIVATE_OPERATOR_ENV_FILE" \
  --mount "type=bind,src=$ABSOLUTE_REFERENCE_LIST,dst=/input/references.json,readonly" \
  --entrypoint node "$VERIFIED_GOWM_IMAGE" \
  dist/scripts/world-object-catalog-backfill.js \
  --scope "$SCOPE" --references /input/references.json
```

The private env file supplies the reviewed operator `DATABASE_URL`; never put
it in the archive or report. Default is a repeatable-read, read-only dry-run,
even if mutation environment variables are already set. Save and review the
returned `databaseFingerprint`, `planHash` and per-reference actions.
`--show-db-fingerprint` is also read-only. For an approved apply, add `--apply`
and provide all three variables in the private environment:

```dotenv
GOWM_REFERENCE_CATALOG_ALLOW_DB_MUTATION=YES
GOWM_REFERENCE_CATALOG_EXPECTED_DB_FINGERPRINT=<exact reviewed fingerprint>
GOWM_REFERENCE_CATALOG_EXPECTED_PLAN_HASH=<exact reviewed dry-run hash>
```

Fingerprint binds database, server endpoint and postmaster start; restart or
changed input requires a new dry-run. Apply locks objects in deterministic order
and rechecks the plan. Concurrent creation either applies once or rejects the
stale plan atomically. A current/legacy projection is a no-op. Foreign, retired,
deleted, missing-state or ownership-invalid references reject the whole list.
Timeouts fail closed; re-run dry-run before retrying. No onsite execution is
part of this implementation; the deployment coordinator controls all such work.

## Qualification and rollback

`DATABASE_ADMIN_URL=<isolated server> npm run validate:world-object-catalog`
creates and removes its own random databases and non-superuser logins. It checks
fresh/076 upgrade, immutable old evidence, dry-run gates, CURRENT/STALE, Scope
isolation, retirement, concurrent creation/idempotence, legacy authority,
1000 state updates without growth, metadata changes and search rebuilds.

After deployment, verify real scoped `reference.get` and validation through the
Gateway, not just role membership or container health. Reference Provider and
registry manifests must match the verified image. The deployment image gate
checks source bytes and both reference/operational compiled manifests.

Rollback stops further maintenance applies and restores a compatible application;
do not delete immutable evidence or reverse migration 077 destructively. Old
applications unaware of the effective native state pin are not a safe reference
reader rollback: stop that capability instead. Previous formal archives remain
available byte-for-byte; this repair does not authorize remote deployment.
