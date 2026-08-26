# P08 — World Platform runtime profile

Status: PASS for runtime composition; Stable semantic admission remains pending P10 black-box receipts.

Implemented a Compose overlay with one published Gateway port, an internal Provider/database network, thirteen independent required Provider processes, optional CRS/Geometry bridge profile, separate bootstrap/registry writer and distinct runtime database credentials. Added thin HTTP entry points for existing Route/Coverage engines and the native STAS adapter. H3 uses a byte-verified reproducible bundle of the source-locked external implementation (no copied algorithm authority).

Real Docker image build and Compose startup passed. `p08-runtime-observation.json` records 13 running Provider processes, 122 catalog operations, Gateway readiness and host-port isolation; `world-platform-profile-report.json` records 9 configuration checks. Situation retains its existing single-scope Preview qualification; optional bridges remain unlaunched and visible as degraded.

Contract closure discovered while connecting the runtime: generic ReferenceKey detection now uses structural schema evidence, world position has a typed GeoJSON Point port, network snap has a typed directed-state port, and Coverage resolves pinned LAYER_FEATURE areas through additive migration 059. Original request identity and area snapshots are preserved; currentness checks include area versions. No existing migrations, canonical facts, or planning algorithms changed. Vocabulary meanings are guarded against removal/redefinition. VERSION/package were advanced to 0.6.2 before final runtime evidence fingerprinting.

Verification: `npm run verify` passed (325 tests, one existing external-database skip; 40 native STAS tests; TypeScript, generated contracts, SQL AST, build). The sandbox-only listening failure was rerun with approval, not suppressed. Targeted contract tests passed (45). Two startup configuration errors were corrected using actual logs: Situation index.js and exact PostGIS 3.6.4. Docker EXPOSE ports are distinguished from published host ports by PublishedPort > 0.

Delayed P00 real baseline validation also passed on an untouched detached baseline worktree: 58 migrations/43 SQL assertions, 160 Gateway runtime checks, T00 security/performance/recovery 72 before restart and 5 after restart. Fresh reports are in baseline-runtime/. This does not replace the P10/P11 real HTTP canaries.
