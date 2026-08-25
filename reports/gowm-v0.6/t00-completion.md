# T00 Scope, Security, Performance, and Recovery Completion

T00 passed against a dedicated `gowm-plus-db` PostgreSQL/PostGIS/MobilityDB/H3/pgRouting container. The successful run `t00-runtime-20260826t0030` applied migrations 001–053, loaded separate Small and Medium snapshots, executed the real Coverage Provider through the Gateway/worker, restarted PostgreSQL, replayed the completed query, read the persisted result, and removed the dedicated container.

The before-restart phase passed 57 checks. Adversarial coverage includes foreign request/result scope, cursor tampering, SQL and URL injection, area/candidate/output limits, audit redaction, Provider error identity, and Coverage-only outage isolation. Concurrent duplicate submission produced one Gateway job, one internal Coverage request, and one result. Cancellation at SOLVING, VERIFYING, and PUBLISHING fenced late heartbeats and late persistence with no ghost result.

Small planning selected one obligation and completed selection, Gateway planning, persistence, and expansion in 223.596 ms with a 1,263,968-byte measured heap delta. Medium planning selected 20 obligations, produced 40 bounded route segments, and completed in 511.490 ms with a 21,503,184-byte heap delta. Each profile records Obligation Selection, Endpoint Resolution, Connector Matrix, Solver, independent Verifier, Result Persist, and GeoJSON Expand measurements. These are acceptance-fixture measurements, not production capacity or SLO claims.

Current code also reran the exact v0.5 S/M Network fixture: Snap p95 10.330 ms, Shortest Path p95 9.745 ms, and bounded 2×2 Matrix p95 10.002 ms. Ratios to the committed v0.5 measurements are 0.903, 0.886, and 0.909, respectively; no material regression was observed.

Migration 053 fixes a real request-identity defect discovered by the runtime: canonical problem and verification hashes are content lookup keys, not cross-request ownership keys. It removes only the two inappropriate global unique constraints, retains request/candidate ownership uniqueness, and preserves ordinary hash indexes. Assertion 038 verifies the catalog boundary. Published migrations 001–052 were not rewritten.

Failed runs from `t00-20260825t2100` through `t00-runtime-20260826t0015` are retained. They exposed Docker readiness assumptions, container initialization races, Provider import and deadline/status expectations, an unqualified schema in evidence SQL, cancellation-fixture validity, restart statistics, and the request-owned hash defect. Failed runs are not counted as acceptance evidence; all created dedicated containers were cleaned.

`AC-T001..AC-T018`, `AC-P015`, and `AC-P016` are PASS. There are no T00 failures, blocks, or deferred required rows.
