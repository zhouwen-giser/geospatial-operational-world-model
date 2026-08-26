# Project status

Last updated: 2026-08-26

## Current candidate

GOWM+ **0.6.2 — Unified World Gateway & Explicit Capability Semantics**.
Baseline: `main@55ebd33ce1f75537fa7a95c9f0dc538bf6d430c1` (0.6.1).
Work is isolated on `codex/gowm-world-platform-gateway-semantics-v0.6.2`.
[PR #7](https://github.com/zhouwen-giser/geospatial-operational-world-model/pull/7).

The final decision is bound to the exact commit in
`/tmp/gowm-v062-final-delivery.json` and the PR completion comment. The committed
preflight keeps three delivery checks pending until local/remote SHA equality,
OPEN Ready PR state, and completion markers are verified. It must not be read as
an independent final delivery receipt.

## Scope and authority

The formal registry contains 15 providers and 122 explicit Manifest 1.1
capabilities. Provider Execution Protocol remains 1.0. Maturity is unchanged:
21 Stable, 99 Preview, 2 Experimental. WSGS default admission requires current
implementation and real black-box proof for all Stable operations. Preview is
separate; Experimental is excluded. The generated consumer lock has no provider
addresses, secrets, database names or deployment topology.

Gateway projects and hashes provider-owned profiles. It does not infer domains,
units, references or relations from operation names. Vocabulary and S001–S014
rules are checked offline against schemas, ports, TypeScript, SQL AST and tests.
Foundation remains the fact authority and its write path is independent.
Network, Route and Coverage algorithms and migrations 001–058 are unchanged.

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

## Evidence

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
