# Project status

Last updated: 2026-08-26

## Current decision

`GOWM+ 0.6.1: IMPLEMENTATION_EVIDENCE_PASS — FINAL_DECISION_RECEIPT_BOUND`

The four audit findings from the withdrawn `5029bce` completion have been
corrected and rerun against the current source: duplicate validation ownership,
false CURRENT/YES for stale results, test-double authority in real gates, and
fail-open conformance schema hashes.

The user's current-design amendment removes old wire/data compatibility only.
Of 229 original rows, 227 remain Required; AC-R012 and AC-S-03 are explicitly
SUPERSEDED_BY_USER, never PASS. The preflight proves 224 cases. The three
delivery cases require exact Git SHA equality, PR Ready, and the final markers.

The final decision is authoritative only when
`/tmp/gowm-v0.6.1-final-acceptance.json` and the PR completion comment name the
current commit and record PASS. Committed reports deliberately remain
`AWAITING_DELIVERY_RECEIPT` for that external step, avoiding a self-hash cycle.

## Delivery

- Baseline: `main@7cd5b133a74b07e28f359176dd13943ab7a6cf54`, version 0.6.0.
- Branch: `codex/gowm-platform-hardening-v0.6.1`, isolated task worktree.
- [PR #6](https://github.com/zhouwen-giser/geospatial-operational-world-model/pull/6), base main.
- Version: 0.6.1 in VERSION, package.json and package-lock.json.
- Final gate: 227 PASS, two superseded, zero failed/blocked/not-run; matching
  local HEAD, origin tracking, ls-remote and OPEN Ready PR head.
- Merge/tag/release/deploy: NOT_RUN.

## Current evidence

| Gate | Result |
|---|---|
| D00 | 58 migrations, 43 assertion suites; clean install, role/scope isolation, rollback, checksum replay and cleanup PASS |
| G00 | 160 real Gateway/Provider/PostgreSQL checks PASS |
| T00 | 72 before / 5 after real dedicated PostgreSQL restart PASS |
| Static regression | 288 Vitest PASS, 40 STAS PASS, type/schema/SQL/build PASS |
| Provider conformance | 11 current reports, 70 unique protocol operations PASS; contract/unit evidence, not live readiness |
| Acceptance preflight | 224 PASS / 3 delivery pending / 2 superseded |

One default external-database Vitest test is skipped; the Required database
proof is D00, not that skip. Historical upgrade runs in D00 are supplemental,
not a promise to support old data or old operation schemas.

The three Docker gates and conformance captured the same before/after SHA-256
source fingerprint:
`e36a2c67eda8c6d6104ecf67b4de917d118ca31fb53bc009a0a9f20fa3d5bcda`.
The runtime lock covers 947 source/config/test/contract files plus evidence.
The final gate rejects byte or file-set drift and reruns static regression.

## Authority boundary

- Foundation remains the sole fact, reference, dataset, lineage, network and
  world-version authority; the Capability Registry is the sole operation registry.
- Platform Validation alone owns `reference.validate` and `result.validate`.
  Both use the current batch contract. Reference/result retirement, expiry,
  source status and currentness stay separate.
- Actual graph/dataset/profile/condition/world versions determine currentness.
  Missing authority stays UNKNOWN/UNAVAILABLE; requested versions are not echoed
  as proof. Same-DataScope sibling DatasetScope results remain opaque.
- Real G00 uses actual World Evidence, Route, Coverage and PostgreSQL Validation
  providers. SQL fixtures seed facts; they do not replace validation authority.
- Coverage generation fencing, independent boundary reconstruction, fixed-point
  objectives, strict no-feasible semantics and receipt-backed compute identity
  remain enforced. `result.get` exposes eight normalized statuses plus source semantics.
- Migrations 001–053 remain immutable; additions run through 058.

## Non-claims

WSGS readiness/client implementation, independent Data Platform Readiness, mock
ELEVATION onboarding, SACS/SDAR/A2A changes and protected publication actions
remain excluded. Contract/unit conformance is not a live H3/STAS deployment
readiness claim. Fixture performance is not a production SLO or capacity claim.
Coverage output is a computational plan, not dispatch, observed completion,
Operational Reality or safety certification.

## Evidence index

See the [current final report](reports/gowm-v0.6.1/final-stable-candidate.md),
[scope amendment](reports/gowm-v0.6.1/current-design-amendment.md),
[static regression](reports/gowm-v0.6.1/static-regression.json), current
`*-acceptance.json` / `*-completion.md`, and the
[runbook](docs/20_PLATFORM_HARDENING_OPERATIONS_RUNBOOK.md).
Earlier narrative reports and run attempts are retained as historical evidence;
they do not certify the corrected candidate.
