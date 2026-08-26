# EP: GOWM+ v0.6.2 Unified World Gateway & Explicit Semantics

## Purpose

One controlled World Gateway registry; explicit provider-owned semantics;
automated static and actual-process proof before Stable consumer admission.

## Actual source lock

Base `55ebd33ce1f75537fa7a95c9f0dc538bf6d430c1`, VERSION 0.6.1, no upstream drift.
Task worktree `/tmp/gowm-world-platform-gateway-semantics-v0.6.2`.
Original user worktree and the v0.6.1 worktree were not modified.
The source lock, original provider/manifest inventory and registry fragment
inventory are in `reports/gowm-v0.6.2`.

## Architecture invariants

Protocol 1.0 and independent Manifest 1.1. No runtime semantic inference,
provider-to-provider imports, Gateway domain algorithms, consumer topology,
Foundation write dependency or canonical fact/algorithm redesign.
Stable maturity cannot be admitted without explicit contract, implementation
and current black-box evidence. No merge/tag/release/production deployment.

## Progress

- [x] P00: actual base and fresh predecessor gates
- [x] P01: explicit schemas, vocabulary, rules and ADR
- [x] P02: deterministic materializer and evidence search
- [x] P03: all 15 providers / 122 operations migrated
- [x] P04: semantic and cross-capability conformance
- [x] P05: Gateway pure projection
- [x] P06: contract and binding revisions
- [x] P07: unified generated registry
- [x] P08: isolated runtime and source-locked H3 bindings
- [x] P09: gated WSGS operation lock generator
- [x] P10: final current-source black-box gate
- [x] P11: final five canaries and recovery evidence, independently repeated
- [x] P12: complete regression and delivery gate; exact Git/Ready PR result is bound by the external final receipt

## Decisions and contract gaps resolved

Generic legacy ReferenceKey structures are recognized structurally and their
kinds proved by authority projections. Current position is a typed GeoJSON
Point with a coordinate port; Network snap consumes coordinates plus explicit
CRS and emits directed state. No schema coercion is performed.
Coverage area resolution uses additive scoped views (059) and preserves original
request identity. Its validation checks pinned geometry version/hash against
authority. Route LOGIN transaction mode (060) allows already-granted controlled
runtime functions without granting direct table writes.
Network retains its published source-byte schema locks, verified by the same
strict mechanism used by frozen Route/Coverage contracts. Forged locks fail.

## Operations downgraded and evidence

None. Stable 21 / Preview 99 / Experimental 2 is unchanged. Optional bridge
unavailability and Situation/STAS runtime qualifications remain explicit.

## Failed attempts retained

Real runs found unique-name fixture ambiguity, missing typed coordinate binding,
GeoJSON boundary precision, a Route LOGIN read-only default, missing frozen
Network hash compatibility, and an incomplete expand request. Repairs preserve
existing domain algorithms and strengthen contract/runtime checks. A stale
container image was rejected by compiled-file comparison. Historical SQL
assertions use isolated clean/upgrade databases, not a canary database already
containing application fixtures. Logs and explanations are kept under
`reports/gowm-v0.6.2/failed-attempts` and per-phase reports.

## Actual runtime validation

Only task-specific Compose projects and PostgreSQL databases are used. Gateway
HTTP carries all semantic canaries; privileged Docker/SQL access only seeds,
observes and injects failures in those isolated resources. Reports distinguish
metadata/unit evidence from actual PostgreSQL/provider execution. Source and
compiled-image fingerprints prevent stale proof. The final stale-area test
appends a new version, so repeated complete canaries need a fresh task database.

## Remaining external blockers

None observed. Completion remains gated by actual results and the final delivery
receipt; pending work is not labeled an external blocker.

## Final preflight

177 local criteria PASS; three delivery criteria are deliberately pending in
the committed report. Full regression: 326 Vitest PASS / one existing optional
external-DB skip, 40 STAS PASS. D00: 60 migrations / 43 SQL suites PASS. Two
fresh Compose runs each passed 662 checks / 30 positive operations. The exact
180/180 final decision must be read from `/tmp/gowm-v062-final-delivery.json`
and the PR completion comment, not inferred from a planned Git action.
