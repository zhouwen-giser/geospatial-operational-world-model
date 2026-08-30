# PR-1 migration report

Migrations 063 and 064 add Effective Snapshot persistence and generic analysis
resource/input-set evidence. The exact-head real database run used PostgreSQL
18.6, PostGIS 3.6.4 and MobilityDB 1.3.0 and reached migration head
`064_analysis_resource_inputs.sql`. Fresh and upgrade paths, backfill, controlled
writes, append-only enforcement, scope and failure rollback passed technically.

Command: `npm.cmd run validate:v07-pr1`; exact commit `835074d...`; exit code 0.
Exact UTC boundaries and a durable raw command artifact were not persisted, so
the package evidence classification is `PARTIAL_EVIDENCE`.
