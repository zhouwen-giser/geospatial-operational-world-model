# World Platform Gateway 0.6.2

## Consumer boundary

Consumers configure `GOWM_GATEWAY_BASE_URL` and supply authentication through
their secret store. They do not discover Provider URLs, SQL tables, containers,
or MCP tools. The generated southbound lock is
`contracts/consumers/wsgs-southbound-operation-lock-v1.json`.

`defaultOperations` admits only Stable operations with current implementation
and real black-box evidence. Preview is a separate opt-in list; Experimental
operations are excluded. A source or contract change invalidates the black-box
receipt until acceptance is rerun. The development `--allow-pending` option
produces an empty default list and is not a release gate.

## Contract authority

Provider Execution Protocol remains **1.0**. Manifest schema **1.1** independently
requires an explicit `semanticProfile` on every descriptor. The unified registry
contains fifteen controlled Provider manifests and 122 operations. It combines
the Capability, Grounding and Planning fragments and rejects collisions,
missing required Providers, identity/hash mismatches and implicit semantics.

The offline materializer follows schema references, typed ports, TypeScript AST,
SQL AST, named algorithms, source locks and tests. Provider-owned declarations
are checked against that evidence. Vocabulary terms cannot be removed or have
their meanings redefined. Unproved Stable semantics block admission; no runtime
fallback, prefix classifier or override map supplies missing profiles.

The Gateway only validates, registers, projects and hashes semantic contracts.
It has no H3, geometry, spatial, STAS, route or coverage algorithm authority.
Providers do not call sibling Providers. The Foundation write path does not
depend on Gateway availability.

## Revisions

The profile hash covers canonical profile JSON. The semantic catalog hash
covers the sorted explicit profiles. The contract revision covers full
descriptors and vocabulary definitions. The binding revision separately covers
Provider identity, implementation digest, manifest hash and approval identity.
Registry order, endpoint relocation, health changes and Gateway restart do not
change the contract revision.

## Runtime

Copy `.env.world-platform.example` to a private file outside Git. Replace every
placeholder with a distinct credential and set the authorized data/dataset
scopes. The database image is pinned; `SPATIAL_POSTGIS_VERSION` must equal the
actual library version (3.6.4 for the locked image), not only its major/minor.

Prepare the H3 adapter from the source lock without copying upstream algorithms
into this repository:

```sh
node scripts/build-locked-h3-bindings.mjs \
  --source-repo /path/to/h3-spatial-toolkit \
  --out /private/artifacts/h3-bindings.mjs
```

The builder requires the exact locked upstream commit and produces two
independent, identical bundles. The runtime checks both the artifact bytes and
the committed digest allowlist. Set the artifact path and digest in the private
environment file. Do not use an unverified injected implementation in real
acceptance.

```sh
docker compose --env-file /private/world-platform.env \
  -f docker-compose.yml -f docker-compose.world-platform.yml \
  --profile world-platform up -d --build
```

Only Gateway publishes a host port, bound to loopback by default. PostgreSQL and
thirteen required Provider processes use an internal network. Bootstrap owns
migrations and controlled registry registration; Gateway and Providers receive
separate restricted database credentials. CRS/Geometry upstreams and bridges
are included in the default `world-platform` profile, retain their deployment
attestations, and are not silently substituted with in-memory implementations.

`/health/live` checks the Gateway process; `/health/ready` checks its registry,
database and runtime. `/health` reports individual Provider degradation. An
optional or failed Provider does not make unrelated operations unavailable.

## Semantic qualifications

- H3 cover uses center-containment and remains Candidate. Retain the original
  geometry and use the declared exact Spatial verifier. A cell hit is not an
  exact geometric fact.
- Spatial inside uses boundary-inclusive `ST_Covers`. NEAR uses metres and
  WGS84 geography/spheroid distance. A bounding-box overlap alone is insufficient.
- Current World position exposes a GeoJSON Point and a separate typed coordinate
  port. Spatial location accepts coordinates; Network location combines those
  coordinates with explicit `crs: EPSG:4326`. DAG bindings do not coerce schemas.
- Coverage area references resolve only pinned LAYER_FEATURE Polygon/MultiPolygon
  versions through an additive scoped read view. Original request identity,
  feature version and content hash are preserved. Result currentness includes
  area changes as well as the routing snapshot. Mathematical validity alone is
  not current-world usability.
- NO_DATA means unavailable evidence, not a negative world fact. Infeasible
  planning is a domain result; infrastructure failure is FAILED.
- Situation retains its existing single-scope readiness qualification. STAS
  remains PREVIEW and delegates to the native MobilityDB service with native
  input validation and tenant authorization. No maturity was silently changed.

## Verification

Run `npm run verify`, manifest/materializer/registry checks and the semantic
catalog gate. Real acceptance uses a dedicated Compose project and database:

```sh
ALLOW_GOWM_WORLD_PLATFORM_CANARY=YES node --import tsx \
  validation/scripts/world-platform-semantic-canary.mjs \
  --env-file /private/world-platform.env
```

For the checked-in canary fixtures, use a fresh project named `gowm-v062-<name>`,
`GATEWAY_DATA_SCOPE_CLAIM=coverage-gateway-runtime` and
`GATEWAY_DATASET_SCOPE_CLAIM=tenant-a`. These values are test scopes, not
production authorization defaults.

This writes dedicated test data and performs controlled stop/start/restart of
only that task's H3 Analysis, Route Provider and Gateway. Use a fresh task
database: the stale-snapshot test intentionally appends a new feature version.
It never resets or removes another project. Reports record real HTTP envelopes,
receipts, snapshots, process/network observations, source fingerprint, generated
Stable contract checks and the five canaries. No production deployment is part
of this implementation task.

Final regression and evidence checks are available as
`npm run validate:world-platform-regression` and
`npm run validate:world-platform-final`. The latter writes 177 local PASS rows
and leaves three Git/PR delivery rows pending. After the candidate is committed,
pushed and the PR is Ready, its `-- --delivery` mode writes the exact-SHA receipt
outside the repository. This prevents a report from hashing its own future commit.
