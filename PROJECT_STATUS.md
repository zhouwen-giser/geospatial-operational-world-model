# Project status

Last updated: 2026-08-25

## Current decision

`GOWM+ 0.6.0: NETWORK_READY / ROUTING_READY / ROAD_COVERAGE_READY`

The stable single-route Road Coverage implementation and every implementation,
contract, real-database, Gateway/worker, security, performance, migration, and
recovery gate are complete. F00 documentation/version convergence is complete.
F01 must aggregate all 226 required rows, commit the final report, push it, and
prove exact local/remote/Draft-PR SHA equality before terminal completion.

## Git delivery

| Item | State |
|---|---|
| Exact v0.5 predecessor | `d6a90ddcd00db946018892c34a327caa631785b0` |
| Candidate branch | `codex/gowm-road-coverage-v0.6` |
| Pull request | Stacked Draft PR #4 against `codex/gowm-network-routing-v0.5` |
| Software version | `0.6.0` |
| Required acceptance | 226 required; phase evidence complete; final aggregation pending F01 |
| Merge/tag/release/deploy | `NOT_RUN`; separately user-controlled |

## Phase status

| Phase group | Status | Evidence |
|---|---|---|
| R00–R01 | PASS | exact predecessor, source/license, clean-room locks |
| A00–A01 | PASS | authority ADR, 19 schemas, OpenAPI, manifest, generated types |
| D00–B01 | PASS | private schema, controlled roles, selection, obligations, canonical problem |
| E00–S03 | PASS | endpoints, boundary policies, Closed/Open DCPP, fixed/both RPP, strict turns |
| V00–L00 | PASS | independent verifier, mutation corpus, alternatives and ranking |
| J00–P00 | PASS | generation-fenced async runtime and five-operation Provider |
| G00 | PASS | real Gateway/DAG/worker/result registry/on-demand expansion |
| T00 | PASS | scope/security, Small/Medium profiles, cancellation, duplicate, restart |
| C00 | PASS | fresh/v0.4/v0.5 upgrade, checksum replay, rollback, compatibility |
| F00 | PASS | README, ADR, runbook, CHANGELOG, status and 0.6.0 convergence |
| F01 | PENDING | final 226-row aggregation and exact local/remote/PR SHA |

## Verified stable boundary

- The v0.5 Network Foundation remains the only GraphVersion, Node, Edge, Arc,
  TurnRule, Profile, Condition, and RoutingSnapshot authority.
- Area/manual selection creates immutable fixed-direction service obligations R;
  the complete traversable network E remains separate and may provide legal
  access, transit, boundary, exit, and return paths without coverage credit.
- Stable modes cover `FULLY_COVERED_EDGE`, `INTERSECTING_COMPLETE_EDGE`,
  `CLIPPED_INSIDE_AREA`, `MANUAL_OBLIGATIONS`, `FIXED_DIRECTION`, and
  `BOTH_DIRECTIONS`, with RETURN_TO_START, FIXED_END, and LAST_AREA_EXIT.
- Closed/Open Directed CPP and fixed/both-direction RPP honor pairwise and
  multi-edge turns, conditions, partial Arc fractions, fixed-point metrics, and
  bounded resources. Every admitted route passes an independent verifier.
- The five-operation Coverage Provider uses the existing Gateway Job/DAG,
  immutable query/derived references, result TTL/revalidation, and on-demand
  ordered GeoJSON expansion. Provider-to-Provider HTTP does not exist.
- Migrations 001–053 and 38 assertions pass fresh, v0.4→v0.6, and exact
  v0.5→v0.6 paths. Checksum replay, atomic rollback, concurrent duplicates,
  three-stage cancellation fencing, and PostgreSQL restart result replay pass.
- Acceptance-fixture measurements: Small end-to-end 223.596 ms; Medium
  20-obligation/40-segment end-to-end 511.490 ms with 21,503,184-byte measured
  heap delta. Current-code v0.5 p95 ratios are 0.903/0.886/0.909 for
  Snap/Shortest/Matrix. These are not production SLO or capacity claims.

## Non-claims and protected actions

Stable v0.6 rejects either-direction service, multiple routes, fleet assignment,
capacity/time windows, CARP/OR-Tools, and dispatchable semantics. A Coverage
result is not a device instruction, dispatch approval, physical execution,
completion, safety certification, observed Operational Reality, or production
availability/capacity qualification.

The uploaded reference remains `REFERENCE_ONLY_SELECTIVE_REIMPLEMENTATION` with
unspecified license; its source and generated/dependency artifacts are excluded.
No merge, tag, release, image publication, or production deployment is authorized
or performed by this candidate workflow.

## Delivery action

Complete F01 final required-matrix aggregation, commit and push the final report,
then verify exact local/remote/Draft-PR SHA equality and GitHub checks. Retain the
Draft PR unless every required row and terminal check is PASS.
