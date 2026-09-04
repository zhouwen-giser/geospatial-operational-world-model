# OpenDRIVE Catalog and GraphVersion admission runbook

## Safety model

`admit` is dry-run by default. A database write is permitted only when all of the following are true:

1. `GOWM_OPENDRIVE_ALLOW_DB_MUTATION` is exactly `YES`.
2. `GOWM_OPENDRIVE_DATABASE_URL` points to a database named `gowm_opendrive_*`, or to the exact development database name `gowm` under the additional gates below.
3. `GOWM_OPENDRIVE_EXPECTED_DB_FINGERPRINT` exactly matches the SHA-256 fingerprint derived from `current_database()`, server address/port, and PostgreSQL system identifier.
4. The artifact source locks, checksums, cardinalities, identities, and EPSG:4326 coordinates validate.

The write uses one transaction. A validation or activation error rolls back all Catalog and Network rows. No database name other than `gowm_opendrive_*` or exact `gowm` is accepted; staging and production databases are never permitted.

## Compile and dry-run

Configure paths through environment variables; they must not be embedded in artifacts or reports:

```bash
export OPENDRIVE_SOURCE_PATH=/absolute/path/to/airport2.xodr
export OPENDRIVE_GEOREF_ORACLE_PATH=/absolute/path/to/gnss_transform.py
export GOWM_OPENDRIVE_OUTPUT_ROOT=/absolute/path/to/opendrive-task-network-v0.1/artifacts

${GOWM_OPENDRIVE_COMMAND:-./scripts/opendrive-task-network.sh} compile
${GOWM_OPENDRIVE_COMMAND:-./scripts/opendrive-task-network.sh} admit
```

The second command validates and plans DatasetVersion/GraphVersion admission without opening a database. Its report remains `NOT_RUN` for database acceptance; static success is not represented as a real database pass.

## Disposable database write

Create a fresh database from the fully migrated GOWM PostGIS/MobilityDB baseline. Its name must begin with `gowm_opendrive_`. First inspect its fingerprint without enabling mutation:

```bash
export GOWM_OPENDRIVE_DATABASE_URL='postgresql://<user>:<password>@<host>:<port>/gowm_opendrive_acceptance_01'
${GOWM_OPENDRIVE_COMMAND:-./scripts/opendrive-task-network.sh} admit --show-db-fingerprint
```

Review the database identity outside the report, then set the returned digest and explicitly unlock a single admission invocation:

```bash
export GOWM_OPENDRIVE_EXPECTED_DB_FINGERPRINT='sha256:<reviewed-digest>'
export GOWM_OPENDRIVE_ALLOW_DB_MUTATION=YES
${GOWM_OPENDRIVE_COMMAND:-./scripts/opendrive-task-network.sh} admit
unset GOWM_OPENDRIVE_ALLOW_DB_MUTATION
```

## Joint development deployment database

The joint development bundle uses the fixed database name `gowm`. It remains denied unless the normal mutation switch and exact instance fingerprint are accompanied by a second explicit database switch and a Compose project identity match:

```bash
export GOWM_OPENDRIVE_ALLOW_DB_MUTATION=YES
export GOWM_OPENDRIVE_ALLOW_DEVELOPMENT_DATABASE=YES
export GOWM_OPENDRIVE_EXPECTED_DB_FINGERPRINT='sha256:<digest-from-this-instance>'
export GOWM_OPENDRIVE_EXPECTED_COMPOSE_PROJECT="$COMPOSE_PROJECT_NAME"
${GOWM_OPENDRIVE_COMMAND:-./scripts/opendrive-task-network.sh} admit
unset GOWM_OPENDRIVE_ALLOW_DB_MUTATION GOWM_OPENDRIVE_ALLOW_DEVELOPMENT_DATABASE
```

`GOWM_OPENDRIVE_EXPECTED_COMPOSE_PROJECT` and `COMPOSE_PROJECT_NAME` must both be valid, non-empty, and byte-identical. The fingerprint includes the database name, server address/port, and PostgreSQL system identifier. Copying a fingerprint or project name from another deployment therefore does not authorize the current instance. `admit --show-db-fingerprint` is read-only even if mutation variables happen to be present.

The `gowm` development database is the only admission target allowed to reuse a scope. It reuses, but never reinserts, the normal bootstrap row only when the database contains exactly one scope and that row exactly matches `GOWM_OPENDRIVE_DATA_SCOPE_KEY=default`, operational domain `TEST`, and description `GOWM v1.1 compatibility scope`. An extra scope, changed metadata, existing target graph, Dataset identity/version, or target graph content fails the transaction closed. A second admission of the same artifacts is therefore rejected without changing any catalog or graph rows. Disposable `gowm_opendrive_*` databases continue to require an absent target scope.

The destructive real-database regression is opt-in and must point only at the administrator URL of an isolated PostgreSQL instance whose `gowm` database may be dropped and recreated:

```bash
GOWM_OPENDRIVE_DEV_REGRESSION_ADMIN_URL='postgresql://<user>:<password>@127.0.0.1:<isolated-port>/postgres' \
  npm run validate:opendrive-development-db
```

It verifies successful bootstrap-scope reuse, single-scope Situation Provider readiness, atomic repeated-admission rejection, and rejection of extra-scope, incorrect-metadata, and existing-graph collisions.

Required scope settings are `GOWM_OPENDRIVE_DATA_SCOPE_KEY`, `GOWM_OPENDRIVE_DATASET_SCOPE_KEY`, and `GOWM_OPENDRIVE_GRAPH_KEY`. Successful admission creates two Catalog layers, 244 routing Features/Edges/Arcs/bindings, 336 pairwise `ALLOWED_ONLY` rules, one 5000 mm/s service TravelProfile, distance and fastest CostProfiles with complete ArcCost coverage, one empty `PARTIAL` ConditionSnapshot, BuildRun/ValidationIssue evidence, and an active GraphVersion.

## Provider verification

Start the real Network Provider against the disposable database, then provide its base URL and transport token only through environment variables. The wrapper passes secrets by environment-variable name and must not print their values:

```bash
export GOWM_OPENDRIVE_NETWORK_PROVIDER_URL='http://127.0.0.1:18096'
export GOWM_OPENDRIVE_NETWORK_PROVIDER_TOKEN='<transport-token>'
${GOWM_OPENDRIVE_COMMAND:-./scripts/opendrive-task-network.sh} verify
```

The routing report must remain `NOT_RUN` or `BLOCKED` when the Provider is not reachable or credentials are absent. A static SQL check must never be labeled as Provider PASS.
Use the `validate` alias when automation must fail unless the real Provider result is `PASS`; unlike evidence-producing `verify`, it exits non-zero for `NOT_RUN`.

Deterministic compiler files are written directly in `GOWM_OPENDRIVE_OUTPUT_ROOT`; reports are written in its parent directory. Both redact credentials and host paths. The required reports use the four-state vocabulary `PASS`, `FAIL`, `NOT_RUN`, and `BLOCKED`.

The development archive includes the deterministic task-network artifacts, source-lock metadata, compiler/admission source, and the containerized management entrypoint. It intentionally excludes ordinary test data, fixtures, and examples. The locked raw XODR and Python oracle are not copied into the archive: supply their absolute host paths at compile time and the wrapper mounts only those two inputs read-only. This keeps the source authority explicit and avoids publishing unrelated local files.

## Development host probes

`scripts/dev-deploy.sh doctor`, `smoke`, and `status` all derive their host HTTP destination from `DEV_BIND_ADDRESS`. The wildcard values `0.0.0.0` and `::` are probed through `127.0.0.1` and `[::1]` respectively; a concrete IPv4 or IPv6 address is probed at that address (with IPv6 URL brackets added when needed). This lets a LAN-bound development deployment pass the same probes it exposes, without silently falling back to loopback.

## Rollback

Catalog and Network source/version rows are append-only evidence and must not be deleted. To roll back:

1. Activate the previously active GraphVersion using the existing atomic activation function and a reviewed rollback policy/actor identity.
2. Confirm the new activation event points to the previous version and Providers resolve it as current.
3. Stop Providers that target the disposable acceptance database.
4. Retire/remove the GDPS test product using GDPS rules; do not delete its source evidence.
5. Destroy the entire disposable database/container only after reports and checksums have been retained.

Do not update immutable GraphVersion status rows, delete activation history, or remove source bindings to simulate rollback.
