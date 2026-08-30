# PR-1 dependency verification

Status: `STACKED_DEPENDENCY_VERIFIED_NOT_MERGED`

- PR-1 candidate: `835074d2aaf9b0eb58f03d381269f2610a624d13`.
- PR-2 candidate: `91e1f030369cd91a8a29308d4ba89bc0339e29f0`.
- `git merge-base --is-ancestor 835074d... 91e1f...`: `PASS`.
- PR-1 migrations 063 and 064 precede PR-2 migrations 065 through 067.
- The final PR-2 gate re-executed PR-1 snapshot contracts (`39/39`), effective
  snapshot runtime (`4/4`), PostgreSQL before/after process reload, and analysis
  resource inputs (`4/4`).
- Database versions: PostgreSQL 18.6, PostGIS 3.6.4, MobilityDB 1.3.0.
- `origin/main` remains `f2894d...`; PR-1 has not been merged there.

This proves the local stacked source dependency and runtime compatibility. It
does not prove the package-required PR-1 merge, publication, CI, or review state.
Consequently PR-2 remains `CONDITIONAL`.

Command evidence: `npm.cmd run validate:world-platform-final`, working directory
`<local-worktree>/gowm-v07-pr2`,
UTC `2026-08-30T09:42:29.022Z` through `2026-08-30T09:44:12.3010375Z`,
exit code 0, exact commit `91e1f030369cd91a8a29308d4ba89bc0339e29f0`.
