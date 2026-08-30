# Late-data and replay report

Status: `PASS` (`P2-L01` through `P2-L05`)

The isolated Gateway/DB scenario produced initial `h1`, replayed Q1 with the
same output hash, appended late evidence to produce `h2 != h1`, replayed the
exact old pin to recover `h1`, and proved query-start isolation. SQL assertions
048 through 050 and 21 focused tests also confirmed that interval, finalization
and trajectory old revisions remained immutable.

Command: `npm.cmd run validate:world-platform-final`; cwd:
`<local-worktree>/gowm-v07-pr2`;
UTC `2026-08-30T09:42:29.022Z`–`2026-08-30T09:44:12.3010375Z`; exit 0;
commit `91e1f030369cd91a8a29308d4ba89bc0339e29f0`; real DB versions 18.6 / 3.6.4 / 1.3.0.
Output excerpts: `GOWM_V07_PR2_GATE_PASS history-late-data` and
`GOWM_V07_PR2_GATE_PASS history-gateway`.
