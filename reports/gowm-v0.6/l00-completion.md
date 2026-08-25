# L00 Verified Alternatives Completion

## Phase / scope

L00 adds `@gowm/road-coverage-alternatives-core`. Ranking accepts only routes that pass the independent verifier's runtime admission boundary; structurally similar but invalid or tampered objects are rejected before deduplication, diversity, or scoring.

## Selection semantics

- Canonical `routeSignature`, not labels or display geometry, is the deduplication identity.
- Weighted Arc overlap uses fixed distance weights over Arc/fraction/role keys.
- Deadhead diversity uses Jaccard distance over non-service Arc/fraction keys.
- Both thresholds are enforced against every already selected route.
- Candidate ordering is deterministic by requested profile order, the profile's verified metric, and route signature.
- Objective vectors are derived from verified route metrics. Explanations state concrete verified duration, distance, deadhead, risk, or combined-cost facts; no marketing labels are accepted as evidence.
- A result reaches `SUCCEEDED` only when `requestedCount` is met. Below the request but at/above `minimumVerifiedCount` is `PARTIAL`; zero admitted routes is `NO_FEASIBLE_PLAN`.
- Search termination is explicit and selection receipts record admitted, deduplicated, and selected counts.
- The returned result, alternatives, nested verification receipts, and pairwise matrix are deeply frozen in memory.

## Tests actually run

| gate | result | evidence |
|---|---|---|
| focused alternative tests | PASS, 6 tests | one/two, dedup/display, diversity, verify-first, rank/explanations, deep freeze/termination |
| machine alternatives gate | PASS, 13 checks | `l00-alternatives-l00-20260825t1235.json` |
| frozen Coverage Result Set contract | PASS | two verified alternatives plus pairwise similarity |
| strict build/typecheck | PASS | repository TypeScript and STAS |
| full repository Vitest regression | PASS, 230 tests | 44 files passed; one pre-existing optional test skipped |
| predecessor/source/boundary guards | PASS | exact v0.5 locks, reference-only policy, authority and Gateway boundaries |

## Acceptance IDs

`AC-L004..AC-L010` and `AC-L012` are PASS. In-memory one/two/minimum-count logic is covered, but `AC-L001..AC-L003` explicitly require real end-to-end execution and remain deferred. `AC-L011` remains deferred until immutable database result-set and pairwise rows are proven in a real PostgreSQL gate.

## Commit / push / PR

L00 is delivered as a semantic phase commit, pushed, and reflected in Draft PR #4.

## Blockers / next

No alternatives-core blocker. Proceed to J00 async run/lease/cancel/progress on the existing Gateway Job lifecycle and immutable Coverage schema.
