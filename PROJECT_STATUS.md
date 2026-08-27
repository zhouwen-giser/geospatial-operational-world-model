# Project status

Last updated: 2026-08-27

## Current candidate

GOWM+ **0.6.3 — Grounding Core Stabilization & Consumer Integration Surface**.
Baseline: merged `main@537fd7ec9e73fa7ab945d1ebec7dd3a6913aa9ee`
(0.6.2). Work is isolated on
`codex/gowm-grounding-core-stabilization-v0.6.3`.

The 0.6.2 Unified World Gateway & Explicit Capability Semantics work was merged
by PR #7. Its reports remain historical evidence; the 0.6.3 decision is bound
to fresh evidence under `reports/gowm-v0.6.3` and the exact candidate SHA.

## Scope and authority

The formal registry contains 15 providers and 122 explicit Manifest 1.1
capabilities. Provider Execution Protocol remains 1.0. Exactly ten qualified
Grounding Core operations moved from Preview to Stable, yielding 31 Stable,
89 Preview, and 2 Experimental operations. The generated v2 consumer lock has
no provider addresses, secrets, database names, or deployment topology.

Gateway projects and hashes provider-owned profiles. It does not infer domains,
units, references or relations from operation names. Vocabulary and S001–S014
rules are checked offline against schemas, ports, TypeScript, SQL AST and tests.
Foundation remains the fact authority and its write path is independent.
Network, Route and Coverage algorithms and migrations 001–060 are unchanged;
migration 061 only adds durable query snapshot and effective-principal context.

## Runtime and qualifications

The world-platform overlay exposes only the Gateway. Thirteen required provider
processes and PostgreSQL use an internal network; two optional CRS/Geometry
bridges are registered but require separately supplied operator artifacts.
Their unavailability is visible. Situation retains its existing single-scope
readiness qualification. STAS stays Preview. These qualifications are not
represented as Stable execution proof.

H3 bindings are reproducibly built from the locked upstream commit and checked
against the source-lock digest before import. H3 cover is a candidate operation;
exact Spatial verification uses the retained original geometry. World position
and Network directed-state ports make their actual schemas explicit. Coverage
resolves pinned area references through scoped views and rechecks area
currentness. Route LOGIN uses controlled write functions with no direct
fact/job-table mutation privilege.

## v0.6.3 evidence

- `reports/gowm-v0.6.3/runtime`: real same-Gateway execution of all ten promoted
  operations, query snapshot restart/replay, and local Provider failure recovery.
- `reports/gowm-v0.6.3/black-box-evidence.json`: content-addressed qualification
  receipts for the promoted operation set.
- `packages/platform/world-gateway-contracts/bundle`: deterministic consumer
  schemas, OpenAPI, generated types, vocabularies, revisions, lock, and manifest.
- `database/migrations/061_grounding_identity_and_query_snapshot.sql`: additive
  durable context migration with SQL AST and real PostgreSQL verification.

## Historical v0.6.2 evidence

- `reports/gowm-v0.6.2/baseline-runtime`: freshly rerun predecessor D00/G00/T00.
- `semantic-implementation-report.json` and 122 semantic attestations.
- `runtime`: real single-Gateway HTTP envelopes, compiled-image identity,
  PostgreSQL/process observations, boundary/H3/reference/snapshot/failure tests.
- `single-gateway-canary-report.json`: A–E status, including isolated H3 failure.
- `regression`: full TypeScript/schema/SQL/Vitest/STAS/build/compatibility gates.
- `d00-runtime-v062final.json`: 60 migrations, 43 SQL assertion suites and
  install/upgrade/replay/rollback checks against dedicated PostgreSQL.
- `final-acceptance-preflight.json` and `validation/gowm-v0.6.2/traceability.csv`:
  all 180 required criteria and their evidence.

One existing optional external-database Vitest test remains skipped. Required
PostgreSQL behavior is verified by the dedicated schema gate and actual
provider processes, not inferred from that skip or metadata-only unit tests.
No merge, tag, release, production deployment or other-repository change is
part of this task. See [operator guide](docs/architecture/WORLD_PLATFORM_GATEWAY_V0.6.2.md)
and [execution record](execplans/EP-gowm-v0.6.2-world-gateway-semantics.md).
