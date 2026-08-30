# PR-1 analysis input security report

Technical result: `4/4` real-database integration tests passed for versioned
analysis inputs, deterministic input-set digest, conflict rejection,
cross-scope rejection, append-only enforcement and scope-before-read views.
Controlled writers used fixed authority boundaries.

Command: `npm.cmd run validate:v07-pr1`; commit `835074d...`; exit 0; database
versions 18.6 / 3.6.4 / 1.3.0. Exact UTC boundaries/raw command artifact were not
retained, therefore formal status is `PARTIAL_EVIDENCE`.
