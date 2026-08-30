# Task execution interval report

Status: `PASS` (`P2-I01` through `P2-I07`)

The real PostgreSQL gate executed migration 065 and SQL assertion 048 plus 12
focused tests. It proved closed, paused/resumed, repeated execution, open as-of,
missing-start conflict, same-time conflict and late-event superseding revision
behavior. Old revisions remained byte-stable and exactly replayable.

- Command: `npm.cmd run validate:world-platform-final`
- Working directory: `<local-worktree>/gowm-v07-pr2`
- UTC: `2026-08-30T09:42:29.022Z` to `2026-08-30T09:44:12.3010375Z`
- Exit code / commit: `0` / `91e1f030369cd91a8a29308d4ba89bc0339e29f0`
- Database: PostgreSQL 18.6; PostGIS 3.6.4; MobilityDB 1.3.0; migration head 067
- Output excerpt: `GOWM_V07_PR2_GATE_PASS task-intervals`
- Artifact: `world-platform/world-platform-final-report.json`
- Shared runtime mutated: `false`
