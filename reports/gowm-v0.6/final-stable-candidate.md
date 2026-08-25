# GOWM+ Road Coverage Planning v0.6 Stable Candidate Report

## Decision

`PASS`

All 226 Required acceptance rows pass with zero failed, blocked, or Required not-run rows. The stable content candidate is `5d0a07811f96b974c10c18bec606b0b2e5924127`; local HEAD, origin tracking, `git ls-remote`, and Draft PR #4 head matched that SHA before this evidence-only report commit.

## Authority and stable scope

The v0.5 Network Foundation remains the only authority for GraphVersion, Node, Edge, directed Arc, TurnRule, Profile, Condition, and RoutingSnapshot. Coverage stores derived obligations, problems, candidates, verification, and results; it neither copies nor mutates a second road network. Provider-to-Provider HTTP is absent and the Gateway contains no coverage algorithm.

Stable v0.6 supports four area/manual selection modes, fixed and both-direction obligations, exact partial Arc service, RETURN_TO_START/FIXED_END/LAST_AREA_EXIT policies, Closed/Open Directed CPP, fixed/both-direction RPP, pairwise and multi-edge turn restrictions, fixed-point objectives, and one route. The required service set R remains separate from the complete traversable network E.

## Independent verification, alternatives, and result semantics

The verifier imports no solver legality, construction, ledger, or cost helper. It independently replays topology, direction, fractions, turns, coverage multiplicity, terminal/boundary policy, profiles/conditions, fixed metrics, route hash, and snapshot freshness. Twelve mutations and the known bug corpus are rejected.

The gold path publishes two verified, materially distinct alternatives with deterministic ranks and truthful fixed-metric explanations. A single requested alternative succeeds; a below-minimum set is explicitly PARTIAL. Result sets register as `QUERY_RESULT/ROAD_COVERAGE_PLAN_SET`, alternatives as `DERIVED_REFERENCE/ROAD_COVERAGE_ALTERNATIVE`, and ordered geometry expands on demand. Every result requires revalidation and is never dispatchable.

## Runtime, security, performance, and recovery

The five Stable operations execute through the real Gateway, Provider, worker, and PostgreSQL runtime. Generation fencing, lease/reaper, idempotent replay, concurrent duplicate singleton behavior, cancellation during solve/verify/publish, atomic result registration, expiry, and PostgreSQL restart recovery pass. Scope, cursor, SQL/URL injection, resource limits, output limits, error identity, outage isolation, and audit redaction pass.

Small real end-to-end planning measured 223.596 ms. Medium selected 20 obligations, produced 40 segments, measured 511.490 ms and a 21,503,184-byte heap delta. Current code on the exact v0.5 S/M fixture measured p95 10.330 ms Snap, 9.745 ms Shortest Path, and 10.002 ms bounded Matrix. These are local acceptance-fixture regression measurements, not production SLO or capacity claims.

## Migration and compatibility

Migrations 001–053 and 38 assertions pass fresh, v0.4 001–032→053, and exact v0.5 001–047→053 paths. All three paths skip 53/53 checksum-identical replay entries, preserve upgrade probes, and roll back deliberate failures without residue. The 47 predecessor migrations and nine dependency contracts remain locked. Coverage v1's 19 schemas, manifest, and OpenAPI remain exact A01 bytes.

## Source/license and explicit non-claims

The uploaded reference remains `licenseStatus=UNSPECIFIED` and reference-only selective clean-room input. Reference source, dependencies, builds, coverage, and environment artifacts are absent from tracked release files.

Stable v0.6 does not implement either-direction service, `routeCount > 1`, fleet or multi-vehicle assignment, capacity, time windows, CARP, OR-Tools, dispatch, device control, physical execution, completion, production HA/PITR, operating-area certification, or production SLO/capacity qualification.

## Protected actions and PR

- Merge: `NOT_RUN`
- Tag/release: `NOT_RUN`
- Image publication: `NOT_RUN`
- Production deployment: `NOT_RUN`

Draft PR #4 remains Draft under the requested delivery workflow. It was OPEN and MERGEABLE/CLEAN with no failing check entries when the stable content SHA was reconciled.

## Markers

`NETWORK_READY`

`ROUTING_READY`

`ROAD_COVERAGE_READY`

`GOWM_ROAD_COVERAGE_V0_6_STABLE_CANDIDATE_COMPLETE`
