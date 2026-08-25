# F00 Documentation, Version, and Status Completion

F00 converges `VERSION`, root package metadata, lock metadata, CHANGELOG, README, and PROJECT_STATUS on `0.6.0`. The status retains `NETWORK_READY` and `ROUTING_READY` and emits `ROAD_COVERAGE_READY` while leaving final exact-SHA/PR reconciliation to F01.

README, ADR 006, the Coverage architecture, and the new Road Coverage operations/recovery runbook describe the single Network authority, R-versus-E separation, four selection modes, partial obligations, strict solver/verifier boundary, Gateway Job ownership, controlled database roles, cancellation/restart behavior, and actual Small/Medium evidence.

The same documents explicitly reject either-direction service, multiple routes, fleet/capacity/time-window assignment, CARP/OR-Tools, dispatchability, device execution, physical completion, and production SLO/HA/capacity claims. The uploaded reference remains license-unspecified and reference-only. The F00 guard confirms that its task package, archive/source, dependencies, build, and coverage paths are absent from tracked release files.

`GOWM_V06_FINAL_DOCS_PASS f00-docs-20260826t0130 checks=31 version=0.6.0` passed. Strict type/contract checks and SQL AST verification for migrations 001–053 and assertions 001–038 also passed after version convergence.

`AC-F001..AC-F006` and `AC-F008..AC-F011` are PASS. `AC-F007` and `AC-F012..AC-F014` remain explicitly deferred to F01 terminal aggregation and GitHub reconciliation; F00 does not borrow those results.
