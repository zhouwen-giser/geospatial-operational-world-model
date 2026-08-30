# Tracklet rebuild report

Status: `PASS` (`P2-T01` through `P2-T04`)

Position ingestion appends dirty evidence rather than synchronously rebuilding.
The generation-fenced coordinator rebuilds deterministically, makes identical
input idempotent, preserves explicit segment/gap sets, and appends lineage for
late data. The bounded sample verified 10,000 input positions, one active dirty
row, 10,000 append-only dirty evidence rows and a 10,000-sample rebuilt Tracklet.

Command/evidence: `npm.cmd run validate:world-platform-final`, isolated real DB,
UTC `2026-08-30T09:42:29.022Z`–`2026-08-30T09:44:12.3010375Z`, exit 0,
commit `91e1f030369cd91a8a29308d4ba89bc0339e29f0`, PostgreSQL 18.6 /
PostGIS 3.6.4 / MobilityDB 1.3.0. Output excerpts:
`GOWM_V07_PR2_GATE_PASS history-trajectory` and
`GOWM_V07_PR2_GATE_PASS history-performance`.
