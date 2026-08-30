# Bounded performance sample report

Status: `PASS` (`P2-R03`)

The developer-workstation sample used 10,000 positions, 5,000 materialized
temporal instants, 1,000 task events, 100 bounded task claims, 100 bounded
Tracklet claims and a 100-point preview limit. Total time was 57,581.32 ms;
fixture 49,731.07 ms, rebuild 4,717.63 ms, slice 19.10 ms, interval 314.68 ms,
worker tick 1,245.77 ms and Tracklet claim 14.39 ms. Required index catalog
entries were present; bounded EXPLAIN used Tracklet/head/task-time index paths.

This is only a bounded local sample. It is not target-hardware capacity, a
production latency SLO, HA, PITR, RPO or RTO certification.

Command: `npm.cmd run validate:world-platform-final`; UTC
`2026-08-30T09:42:29.022Z`–`2026-08-30T09:44:12.3010375Z`; exit 0;
commit `91e1f030369cd91a8a29308d4ba89bc0339e29f0`; PostgreSQL 18.6 /
PostGIS 3.6.4 / MobilityDB 1.3.0. Output excerpt:
`GOWM_V07_PR2_GATE_PASS history-performance`.
