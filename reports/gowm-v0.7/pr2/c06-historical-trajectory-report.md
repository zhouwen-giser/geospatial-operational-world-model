# Historical trajectory report

Status: `PASS` (`P2-H01` through `P2-H06`)

Migration 067, SQL assertion 050 and 45 focused tests proved one authoritative
source/session, ENVELOPE movement through pauses, ACTIVE pause exclusions,
explicit unknown gaps without bridging, completeness accounting, fail-closed
ambiguity, captured-at isolation, immutable revisions and exact pinned replay.
The dedicated queue worker made one claim and committed exactly one trajectory
revision; stale generation work rolled back atomically.

Command/evidence: `npm.cmd run validate:world-platform-final`, cwd
`<local-worktree>/gowm-v07-pr2`,
UTC `2026-08-30T09:42:29.022Z`–`2026-08-30T09:44:12.3010375Z`, exit 0,
commit `91e1f030369cd91a8a29308d4ba89bc0339e29f0`, PostgreSQL 18.6 /
PostGIS 3.6.4 / MobilityDB 1.3.0. Output excerpts:
`GOWM_V07_PR2_GATE_PASS history-trajectory` and
`GOWM_V07_PR2_GATE_PASS history-queue-worker`.
