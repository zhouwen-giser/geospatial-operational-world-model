# Project status

Last updated: 2026-08-26

## Current decision

`GOWM+ 0.6.1: STABLE CANDIDATE — REVIEW DELIVERY`

The implementation, public contracts, generated artifacts, nine-provider
conformance suite, 57 migrations, and 42 SQL assertion suites are complete.
Real D00, G00, T00 and C00 gates all PASS. All 229 case mappings have verified
test/runtime evidence. The final PASS decision is bound to the exact commit and
Ready PR state recorded in `/tmp/gowm-v0.6.1-final-acceptance.json` and the PR
completion comment; a changed commit must pass that gate again.

## Git delivery

| Item | State |
|---|---|
| Exact source baseline | `main@7cd5b133a74b07e28f359176dd13943ab7a6cf54` |
| Candidate branch | `codex/gowm-platform-hardening-v0.6.1` |
| Pull request | PR #6 against `main`; Ready required and verified by final receipt |
| Software version | `0.6.1` |
| Required acceptance | 229 explicit case mappings; final gate requires 229 PASS / 0 failed / 0 not-run |
| Merge/tag/release/deploy | `NOT_RUN`; outside task scope |

## Phase status

| Phase | Status | Boundary/evidence |
|---|---|---|
| R00–R01 | PASS | source reconciliation, package validation, compatibility plan |
| C00–C05 | PASS | generation fencing, shared Network Query Core, boundary authority, currentness, objectives, truthful results |
| C06 | PASS | G00 150 checks; T00 72 pre-/5 post-restart checks |
| W00–W02 | PASS | semantic projection, result validation, snapshot get/validate |
| D00–D02 | PASS | Data Product contracts, discovery/detail operations, nine-provider conformance |
| S00–S02 | PASS | migrations/compatibility, security/recovery/performance, docs/version |
| S03 | Receipt-bound | final 229-case gate verifies exact SHA, clean worktree and PR Ready |

## Hardened authority boundary

- The Data Foundation remains the only fact, reference, dataset, lineage,
  Network, and world-version authority. The Capability Registry remains the
  only operation registry.
- Capability semantics and Data Product descriptors are deterministic scoped
  projections. Platform Validation reads existing result/reference authorities
  and an immutable snapshot registry; it does not recompute or create facts.
- Coverage workers receive database-allocated attempts and generations. Reclaim,
  cancellation, heartbeat, artifact writes, and result publication are fenced.
- Candidate boundary events are hints. The verifier reconstructs crossings and
  endpoint membership from pinned versioned Arc geometry through
  `gowm_network_v1` security-definer read contracts.
- Frozen computation validity, snapshot currentness, result TTL, and execution
  completion are separate dimensions. `UNKNOWN` never silently becomes
  `CURRENT`.
- Existing v1.0 public bytes and migrations 001–053 are preserved; changes are
  additive in contracts/gowm-v0.6.1 and migrations 054–057.

## Runtime and acceptance boundary

The required database stack is PostgreSQL 18, PostGIS 3.6, MobilityDB 1.3,
h3-pg/h3_postgis 4.5.0, and pgRouting 4.0.1. Fresh, v0.4, v0.5 and seeded v0.6.0
migration paths, checksum replay, deliberate rollback, scope isolation,
Gateway/DAG, result/snapshot validation, real restart and bounded S/M fixtures
all passed. The runtime source freeze locks 811 files and all four reports.

Full Vitest: 264 passed / 0 failed; the one default external-database test is
skipped in that runner and covered by D00's real database gate. STAS: 14 test
files passed. All Required real gates were run; none relies on the skipped test.

The deterministic provider-conformance aggregate is
`sha256:7ce2f4b58f74b0b725f4720dc96db4f00b590e297978704097ba70313abe07ad`.
Acceptance-fixture measurements are not production SLO or capacity claims.

## Explicit exclusions and non-claims

R2 excludes WSGS client/readiness, separate Data Platform Readiness, mock
ELEVATION onboarding, merge, tag, release, and deploy. It does not build SACS,
SDAR, or A2A.

A Coverage result is not a device instruction, dispatch approval, physical
execution, observed completion, safety certification, Operational Reality, or
production availability/capacity qualification. Uploaded reference material
remains reference-only and is not redistributed.

## Delivery evidence

See [final report](reports/gowm-v0.6.1/final-stable-candidate.md), per-phase
`*-completion.md` / `*-acceptance.json`, and the final receipt command in the
[runbook](docs/20_PLATFORM_HARDENING_OPERATIONS_RUNBOOK.md). The receipt is
outside Git so that it can name the final commit without a self-hash cycle.
No protected publication action is part of this delivery.
