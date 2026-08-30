# PR-1 restart and conflict report

Technical exact-head database sequence passed:

- before restart: 3 tests passed, 1 reload-only test skipped;
- after a fresh process: 1 reload test passed, 3 setup tests skipped;
- stale manifest CAS and superseded execution fence were rejected;
- node and Effective Snapshot commit rolled back together on injected failure.

Environment: PostgreSQL 18.6, PostGIS 3.6.4, MobilityDB 1.3.0. This was a real
process/database reload, not an in-memory substitute. The absence of retained
exact UTC command boundaries/raw transcript keeps the formal evidence state
`PARTIAL_EVIDENCE`.
