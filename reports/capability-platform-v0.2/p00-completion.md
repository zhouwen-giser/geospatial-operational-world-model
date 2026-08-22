# P00 Completion Report

## Scope completed

- Preserved and validated the supplied task package in ignored `.intake`.
- Verified all three outer input ZIP hashes and package structure.
- Queried actual GOWM and H3 remote refs and reviewed source drift.
- Ran the existing GOWM source, real database, HTTP, STAS, scope, and Compose
  runtime baselines.
- Created `codex/gowm-capability-platform-v0.2` from the verified default HEAD.
- Created the living ExecPlan, sync state, and machine-readable P00 acceptance.

## Source state

```text
branch: codex/gowm-capability-platform-v0.2
base: codex/unify-gowm-stas-v0.1.0
local SHA before P00 commit: d1ff3b81b8bf577965b00edc1bd06acaaeda706c
remote default SHA: d1ff3b81b8bf577965b00edc1bd06acaaeda706c
GOWM source drift: none
H3 source: main@74fc8657072dd58a2f8e4317c1caef8bfd10e024
provider locks: CRS 3110e7b3; Geometry 3527a06d; Spatial 15cdaf00
```

The GitHub remote exposes `codex/unify-gowm-stas-v0.1.0` as its default and only
branch. It exactly matches the task package lock; no reset or baseline update was
needed. H3 remote `main` exactly matches its task lock.

## Files/migrations

This phase adds planning/evidence files and fixes an asynchronous polling race in
the existing HTTP acceptance client. It also refreshes the repository's three
machine runtime evidence files from this isolated run. Product behavior and all
assertions remain unchanged. Migrations `001` through `010` were not edited.
Their P00 SHA-256 lock is:

```text
9491075269f48755a83787fa3649d0b12c1ed03eda1e0925ef8a9ce484cf427e 001_initial_schema.sql
56eb394285aca3d55f67ddd951f91f2c1035abda458edfa22b0ade3836611297 002_views_and_functions.sql
a7bfcaa6fd984395f5115ca9b6c43cb2fcdfb18c6497e1c68e2a07a0bb21283d 003_situation_observer.sql
20e9db17e91a0f73f4d0a14dec1eafa65751bab8532e784226d8d2c123e9d3c9 004_geography_indexes.sql
ccbe4f30f8990f800bc5a32abb8ef56ecf75281abeaa910b3b8a43f4f8769ebc 005_situation_rank_indexes.sql
366421f5f76e117838e8116f99644ffe3a86584a58abf84587c6a8b13b1a8a71 006_observation_altitude.sql
a607ce9013fa86c842cf645edcd28d8e56d5f484794eba4dfc74afea8b42ae85 007_active_relation_uniqueness.sql
2887028d9cd389119df2be650dcbb9f4700c34826dd74d27b44f7fe3de0bf914 008_h3_pg.sql
1d428971cad16f7ed602a39594c5835736044744b8a8b46a18e641e6d2d5435c 009_gowm_plus_canonical_evidence_and_mobility.sql
e61a99392a713b6490aedb5c4ef89420cf056c8fbc278680eec06f5d2ed782b8 010_unified_stas_contracts_roles_and_coverage.sql
```

## Tests actually run

| command | result | evidence |
|---|---|---|
| task package validator | PASS | `TASK_PACKAGE_VALID schemas=13 examples=5 acceptance=96` |
| unchanged package preflight | PASS | all three SHA-256 checks and `PREFLIGHT_PASS` |
| `npm.cmd run verify` | PASS | root 25 pass/1 explicit DB skip; STAS 39 pass; checks/builds pass |
| isolated `docker compose config --quiet` | PASS | exit 0 |
| `docker version` server probe | PASS | Docker Desktop 4.81.0 / Linux Engine 29.6.1 |
| isolated `docker compose up -d --build` | PASS | migrations 001-010 exit 0; all services healthy/running |
| SQL assertions and extension versions | PASS | PostgreSQL 18.4; PostGIS/Raster 3.6.4; MobilityDB 1.3.0; H3 4.5.0 |
| `RUN_DB_INTEGRATION=1 npm.cmd run test:integration` | PASS | 1/1 real database test |
| HTTP acceptance | PASS | all G1-G8 checks; machine evidence in `p00-http-acceptance.json` |
| `npm.cmd run validate:stas` | PASS | 15/15 real STAS tools and scope/candidate gates |
| `npm.cmd run validate:ingest-stas` | PASS | three versions, two sequences, one UNKNOWN gap, replay |
| `npm.cmd run validate:evidence` | PASS | versions, role denials, and target query plan captured |

The root `verify` command skips the opt-in database test by design. P00 then ran
that same test separately with `RUN_DB_INTEGRATION=1`, where it passed.

## Acceptance cases

- `AC-001`: PASS.
- `AC-002`: PASS.
- `AC-003`: PASS for current tracked content and ignored intake boundary.
- `AC-004` through `AC-008`: `NOT_RUN`; their owning implementation phases have
  not occurred. P00 traceability does not convert future architecture gates into
  baseline passes.

## Security/ownership review

- No external provider source, ZIP, package, or image is added to tracked files.
- No credentials were written. Compose config used process-local non-secret test
  values and an ignored Docker config directory.
- CRS and Geometry remain non-redistributable pending project-license selection.
- No merge, tag, release, deployment, or force operation occurred.

## Failed attempts

- WSL-backed `bash` was inaccessible; Git Bash was selected.
- Git Bash's WindowsApps `python3` alias was not executable; an ignored shim to a
  locally installed Python enabled the unchanged preflight script.
- Compose config first rejected missing isolation variables, then passed with
  process-local values.
- Docker daemon probe failed before Docker Desktop startup, then passed after the
  installed application was started.
- The first HTTP acceptance run reached 9/10 functional checks; the canonical
  Mobility request raced its asynchronous 202 projection and returned 404. The
  corresponding tracklet appeared with two sequences immediately afterward.
  The client now polls the same endpoint to its existing 15-second deadline,
  preserving every semantic assertion. Rebuild and rerun passed all checks.
- GitHub CLI token is stale. Draft PR creation is pending the P00 push and an
  authenticated browser path.

## Commit/push/PR

Pending immediately after this report is validated. The intended commit is:

```text
chore(v0.2): lock capability platform baseline
```

## Blockers

No source/input blocker exists. Docker and the existing GOWM runtime baseline are
available. New v0.2 provider results still require their own gates. Stale `gh` authentication affects
CLI PR creation only; it does not affect source implementation.

## Next phase

P01 corrects and freezes platform contracts. In particular it replaces all DAG
placeholder hashes, closes the typed binding/budget contract, adds missing API
lifecycle endpoints, and establishes controlled manifests for the mock and GOWM
Situation providers before generated TypeScript/runtime validation is added.
