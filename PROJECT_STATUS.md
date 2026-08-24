# Project status

Last updated: 2026-08-25

## Current decision

`GOWM+ 0.5.0: NETWORK_READY / ROUTING_READY`

The authoritative Network Graph foundation, read-only Network Provider, basic
Route Planning Provider, independent verifier, immutable route result store,
and Gateway integration pass every required implementation and runtime gate.
Documentation/version convergence is complete. Final exact local/remote SHA
and GitHub candidate reconciliation remain in S01; the pull request remains
Draft until that evidence is recorded.

## Git delivery

| Item | State |
|---|---|
| Baseline | `main` at `db575f79c874a69f65a2043a7e463338524b713d` (`0.4.0`) |
| Candidate branch | `codex/gowm-network-routing-v0.5` |
| Pull request | Draft PR #3 against `main` |
| Software version | `0.5.0` |
| Merge/tag/release/deploy | `NOT_RUN`; separately user-controlled |

## Phase status

| Phase group | Status | Evidence |
|---|---|---|
| B00–B01 | PASS | baseline and source/license locks |
| A00–A01 | PASS | authority ADR and frozen contracts |
| D00–D02 | PASS | composite DB image, schema, scoped read contract |
| N00–N04 | PASS | deterministic graph build through atomic activation/replay |
| P00–P01 | PASS | 11 Network operations and AC-P001..AC-P020 real acceptance |
| R00–R03 | PASS | generation-fenced runtime, route planner, verifier, immutable results |
| G00 | PASS | Direct, typed DAG, async, cancellation, reconstruction replay |
| T00 | PASS | migration, security, S/M performance, restart recovery, SBOM |
| S00 | PASS | docs, version, changelog, ADR, runbook, status convergence |
| S01 | PENDING | exact SHA, Required matrix, Draft PR terminal checks |

## Verified runtime boundary

- PostgreSQL 18.6, PostGIS 3.6.4, MobilityDB 1.3.0,
  h3/h3_postgis 4.5.0, and pgRouting 4.0.1.
- Migrations 001–047 and 32 SQL assertion suites on fresh and v0.4-upgraded
  databases; locked baseline migrations 001–032 remain unchanged.
- Immutable GraphVersion topology with directed Arcs, turn restrictions,
  profiles, Condition Snapshots, diagnostics, validation, activation, and replay.
- Eleven frozen Network operations and four frozen Route operations; route
  alternatives remain PREVIEW.
- Coordinate/reference endpoints, joint snap candidates, ordered Waypoints,
  Via/Avoid Feature, exact PostGIS Avoid Area, and shortest/fastest/risk/energy/
  weighted objectives on a real scoped database role.
- Independent verification, stale graph/condition detection, mutation
  rejection, idempotent byte-equivalent replay, cancellation fencing, lease
  reclaim, immutable QueryResult registration, and Gateway reconstruction.
- Fresh/v0.4 upgrade, migration checksum repeat, atomic rollback, database
  restart recovery, route/location/token redaction, and DB/service SBOMs.
- S/M fixture measurements: Snap p95 11.437 ms, Shortest Path p95 11.000 ms,
  bounded 2×2 Matrix p95 11.002 ms, graph build gate 1465 ms.

## Authority and non-claims

A Route Plan is a computational `QUERY_RESULT` over a pinned RoutingSnapshot.
It is not an instruction to a device, dispatch authorization, proof of physical
execution, observed Operational Reality, or evidence of regional road coverage.
Condition or active-graph changes can make the immutable result `STALE`; they
never rewrite it.

This candidate does not claim regional road coverage, multi-vehicle or fleet
optimization, production IdP/authorization, HA, production backup/PITR
rehearsal, operating-area CRS/grid certification, or production-sized SLO and
capacity qualification. Local S/M timings are regression evidence only.

## Delivery action

Complete S01 exact-SHA and Required-matrix reconciliation while retaining Draft
PR #3. Merge, tag, release, image publication, and deployment require separate
user authorization.
