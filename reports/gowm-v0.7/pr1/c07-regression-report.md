# PR-1 regression report

Status: `PARTIAL`

The exact PR-1 feature/database final gate passed technically, and PR-1 is an
ancestor of the exact PR-2 candidate whose root/STAS/platform regression later
passed. However, the PR-1 worktree does not contain an exact-head
`world-platform-final-report.json`, its older world-platform supporting reports
are not a complete exact-commit record, and exact PR-1 regression UTC boundaries
were not retained. The package forbids promoting these facts to formal P1-R01 or
P1-R02 PASS.

No duplicate full regression was run merely to repair report metadata, honoring
the request to reduce unnecessary test work.
