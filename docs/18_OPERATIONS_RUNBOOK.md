# GOWM+ v0.4 candidate operations runbook

## Preconditions

- Docker Engine 24+ with Compose v2
- 4 CPU, 8 GiB RAM minimum for validation
- Node.js 22+
- unique `COMPOSE_PROJECT_NAME`
- distinct long `POSTGRES_PASSWORD` and `STAS_DB_PASSWORD`
- certified projected metre `ANALYSIS_SRID` for the operating area

Do not reuse the synthetic validation SRID as production certification.

## Install and start

```bash
cp .env.example .env
npm ci
npm run verify
docker compose config --quiet
docker compose build postgres migrate stas
docker compose up -d postgres
docker compose run --rm migrate
docker compose up -d stas
curl --fail http://127.0.0.1:8080/readyz
```

Grounding deployments additionally start the Reference, Dataset, World
Evidence, Operational Reality Providers and the controlled Gateway using
distinct transport and database credentials. Never expose a Provider directly
as the public trust boundary.

PowerShell uses `Copy-Item`, `npm.cmd`, and the same Docker Compose commands.
Never commit `.env`.

## Migration behavior

`scripts/migrate.ts` applies `database/migrations/*.sql` in lexical order inside
transactions, records SHA-256 checksums, rejects modified applied migrations,
and sets the `stas_app` password without logging it. Re-running is a no-op only
when every recorded checksum matches.

Fresh-install runtime assertions:

```bash
docker compose exec -T postgres psql -X -U gowm -d gowm \
  -v ON_ERROR_STOP=1 -f database/tests/001_v12_assertions.sql
```

The stable candidate contains migrations 001–032. Migrations 001–014 are
byte-locked in `database/migration-baseline-lock.json`; never edit an applied
migration. Fixtures are validation-only and must never be loaded into
production.

## Candidate gates

```bash
npm run verify
npm run validate:boundaries
npm run validate:stable-contracts
DATABASE_ADMIN_URL=<admin-url> npm run validate:stable-migrations
DATABASE_URL=<database-url> npm run validate:operational-ready
DATABASE_URL=<database-url> GOWM_DB_CONTAINER=<exact-container-name> \
  npm run validate:stable-runtime
```

`validate:stable-migrations` creates and removes uniquely named disposable
databases. `validate:stable-runtime` deliberately restarts only the exact
container named in `GOWM_DB_CONTAINER`; never point it at a production system.

## Health and role checks

```bash
curl --fail http://127.0.0.1:8080/healthz
curl --fail http://127.0.0.1:8080/readyz
curl --fail http://127.0.0.1:8080/v1/tools
```

`/readyz` must report the pinned MobilityDB/PostGIS versions, schema contract,
and configured SRID. A role audit must show contract-view SELECT and analysis
sink INSERT, with base-table SELECT/UPDATE denied.

## Backup, restore, and PITR

Logical backup procedure:

```bash
docker compose exec -T postgres pg_dump -U gowm -d gowm \
  --format=custom --no-owner --file=/tmp/gowm.dump
docker compose cp postgres:/tmp/gowm.dump ./backups/gowm.dump
```

Restore must target a new isolated project/database. Install extensions and
migrations first, restore with `pg_restore --clean --if-exists --no-owner`, then
run runtime assertions, row-count/referential checks, and an API replay probe.
Do not restore over the only copy.

For PITR, configure external WAL archiving and base-backup retention appropriate
to the deployment. Rehearse recovery to a timestamp in an isolated environment,
record recovery point/lag, then execute the same assertions. This candidate
supplies the procedure but does not claim a completed production backup/PITR
rehearsal.

## Rollback

Migrations are forward-only because canonical and analysis facts are immutable.
Application rollback means deploy the previous compatible image while retaining
the database. Database rollback requires restoring a verified pre-change backup
into a new project and switching traffic after validation. Never manually delete
schema-migration rows or rewrite canonical facts.

## Incident triage

1. Freeze new writes at the service boundary; preserve database and container logs.
2. Record exact image digests, migration checksums, `/readyz`, and candidate SHA.
3. Distinguish database unavailability, scope denial, query deadline, and MQTT
   delivery failure; durable projection/outbox rows are not proof of delivery.
4. Restore service only after a read-only evidence query and scoped replay pass.
5. Add the defect and regression evidence to the register.

## Shutdown

```bash
docker compose down
```

Adding `--volumes` destroys the project database and is allowed only for an
explicitly identified disposable validation project after evidence export.
