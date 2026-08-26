# EP: GOWM+ v0.6.1 Platform Hardening

This is a living plan.

## Purpose

Converge Road Coverage correctness, expose machine-readable platform semantics,
and project the existing catalog as scoped public data products without adding a
second authority.

## Actual source lock

- Base: `main@7cd5b133a74b07e28f359176dd13943ab7a6cf54`
- Version: `0.6.0`
- Migrations: 001–053, immutable
- Candidate: `codex/gowm-platform-hardening-v0.6.1`
- Package: `TASK_PACKAGE_VALID schemas=21 semanticProfiles=10 examples=10 acceptance=229`

## Architecture invariants

- Providers consume versioned read contracts through shared core packages.
- Gateway projects registry semantics and orchestrates; it owns no domain algorithms.
- Candidate boundary events are hints, never verification authority.
- Frozen validity, current snapshot currentness, TTL, and execution status remain distinct.
- Data Product and semantic catalogs are projections of existing authorities.
- WSGS, SACS, SDAR, A2A, mock ELEVATION onboarding, merge, release, and deploy are excluded.

## Phase progress

- [x] R00
- [x] R01
- [x] C00
- [x] C01
- [x] C02
- [x] C03
- [x] C04
- [x] C05
- [x] C06
- [x] W00
- [x] W01
- [x] W02
- [x] D00
- [x] D01
- [x] D02
- [x] S00
- [x] S01
- [x] S02
- [ ] S03 — implementation preflight passed; exact commit and Ready state are
  independently receipt-bound after commit/push, not self-hashed in Git

## Decisions

- R2 cancellation rules override the residual mock-ELEVATION sentence in numbered file 12.
- The user removed old wire/data compatibility from scope. There is one current
  contract and owner per operation; AC-R012 and AC-S-03 are SUPERSEDED_BY_USER,
  not PASS. Baseline migration immutability remains required.
- New database changes start at migration 054.
- Platform validation is a scoped read projection backed by existing Reference,
  Result, Catalog, and Network authorities plus an immutable snapshot registry;
  it does not create a second fact authority or automatically recompute results.

## Discoveries

- Baseline tests pass when local loopback binding is permitted.
- The v0.6 Coverage claim API still accepts caller-supplied attempts and requires correction.
- Existing Provider implementations duplicated Network Provider repository imports;
  the shared `network-query-core` now owns those queries.
- The original Coverage verifier trusted candidate boundary hints, conflated
  freshness/currentness, and treated objective profiles as primary selection.
- The first real Gateway pass exposed typed-empty PostGIS intersection and
  provider-role boundary-membership defects; both now fail closed through the
  versioned `gowm_network_v1` contract.
- Required-matrix reconciliation found that `catalog.*` operations were
  registered correctly but dispatched to the ordinary Dataset branch. The
  Data Product projection now has a behavioral regression test and explicit
  real PostgreSQL/Gateway coverage in C06.
- PostgreSQL Result Validation discarded the Provider's original domain status
  in favor of its normalized registry status. It now preserves `result_record`
  status while continuing to normalize at the public validation boundary.
- Data Product descriptors initially advertised hard-coded capabilities. The
  projection now reads only approved, enabled registry operations through a
  scoped, read-only catalog view and filters them by authoritative data binding.

## Historical failed attempts retained

- The approved current-candidate D00 rerun rejected migration 055 because the
  replacement cost-profile view omitted the existing `surface_weight_ppm`
  column. The additive view now preserves all old columns before `created_at`.
- The next D00 pass caught a wrong catalog-role name; migration 057 and G00 now
  use the existing least-privileged `gowm_catalog_reader` authority.
- Real G00 also caught raw PostgreSQL Date values in catalog hashing, missing
  WORLD_SNAPSHOT_BOUND Network capability bindings, an invalid empty-output
  snapshot error, objective-specific combined-cost replay drift, and duplicate
  alternative identities across requests. All were fixed and rerun against
  the real database; regression tests retain those cases.
- Migration 056 now registers separate compute/data hashes from integrity
  receipts. Its initial legacy UNKNOWN fallback was later removed from the
  current public publication path by migration 058, following the user amendment.
- The default T00 create-container request twice timed out at execution review.
  A narrower, explicitly consented reuse mode verified the dedicated container
  had no foreign databases, created its own database, restarted it, and cleaned
  up only its own database. This mode passed 72 pre-/5 post-restart checks.
- A T00 infrastructure-failure expectation initially assumed INTERNAL_ERROR;
  the real closed connection pool correctly returns PROVIDER_NOT_READY. The
  regression now proves the actual contract error and never NO_FEASIBLE_PLAN.

- The package validator initially used system jsonschema 3.2.0; an isolated 4.25.1
  environment was used without changing the repository.
- The sandboxed baseline test could not bind loopback; the permitted rerun passed.
- The first fixed database-image build failed after Debian package downloads
  timed out; the host-network retry is retained as the recovery attempt.
- The first current-candidate G00 run reached real validation and obligation
  selection but failed inside the plan node. Container-log and diagnostic
  reruns then remained unavailable because the execution approval service
  timed out/rejected the Docker-backed command; failed evidence is not accepted
  as completion evidence.

## Actual validation

- `bash scripts/preflight.sh .`: PASS
- task validator: PASS (21 schemas, 10 profiles, 10 examples, 229 cases)
- `npm run check`: PASS
- `npm run verify:sql`: PASS (58 migrations, 43 assertion suites)
- `npm test`: 288 passed, 1 skipped (default external DB test; real Docker D00 covers it)
- `npm --prefix services/stas test`: 40 tests passed, zero failed/skipped
- `npm run build`: PASS
- Provider conformance: PASS for 11 current reports / 70 protocol operations;
  report hash `sha256:3b2e6d911b08ce1a5b378b7f33b868f053f5e1ee20eadd60d350a23d9175fdfa`.
  Evidence is explicitly CONTRACT_AND_UNIT_PROTOCOL / NATIVE_CONTRACT_AND_UNIT,
  not a live readiness claim.
- D00 real runtime: PASS (58 migrations, 43 assertions, fresh install, four
  checksum replays, rollback, scope/grants and cleanup; historical upgrades supplemental).
- G00 real Gateway/Provider/PostGIS: PASS (160 checks).
- T00 recovery/security: PASS (72 before / 5 after real PostgreSQL restart).
- Predecessor integrity: 53 baseline migrations and 103 retained contract artifacts
  byte-locked. Old-wire/data compatibility is no longer Required.
- W00–W02 and D00–D02: PASS in the same real Gateway runtime.
- Per-case evidence preflight: 224 PASS, 3 delivery pending, 2 superseded across
  229 original rows. Runtime source/evidence frozen in `runtime-source-lock.json`.

## Corrective audit closure

The prior 5029bce completion was withdrawn and PR #6 returned to Draft. The
following reproduced findings were corrected without preserving obsolete APIs:

- Platform Validation is the sole current reference/result validation owner.
- PostgreSQL authority checks actual scoped graph/dataset/travel/cost/condition/
  world versions, source status, lifecycle and TTL. Missing authority is not CURRENT.
- Migration 058 adds scoped authority/lifecycle views and dataset isolation for
  result.get/reference sets. It rejects public compute identity without a real
  integrity receipt and maps no-feasible outcomes without legacy NO_DATA fallback.
- G00 uses actual World Evidence geometry and PostgreSQL validation providers,
  publishes real route/coverage results and mutates actual current authority.
- Conformance inspects current executable manifests, exact known hashes and all
  provider co-registration; AST inspections and adversarial tests cover prior
  hash/import fail-open paths. STAS health tests separate liveness from readiness.
- Intermediate G00 runs exposed undefined optional dates in fact hashing, missing
  geometry port metadata, forbidden graph reactivation and expired TTL expectations.
  Corrected implementations/assertions were rerun; failures are retained, not PASS.
- The current-schema addition exposed an ambiguous old test's basename lookup;
  the test now names its explicit historical schema namespace.

The final source-locked runs are v061-locked-d00/g00/t00. Each Docker gate and
conformance recorded identical before/after fingerprint
`e36a2c67eda8c6d6104ecf67b4de917d118ca31fb53bc009a0a9f20fa3d5bcda`
over 947 files. Only documentation and generated evidence changed afterward.

## Final delivery

R00–S03 evidence is delivered on PR #6. The final gate reruns static regression,
retains 229 named rows (227 effective Required, two superseded), rejects
runtime-source/report drift, and
requires exact local/tracking/remote/PR SHA equality plus OPEN Ready state.
The authoritative final receipt is `/tmp/gowm-v0.6.1-final-acceptance.json` and
the corresponding PR completion comment. A changed candidate must rerun the
gate. No merge, tag, release or deployment is part of completion.
