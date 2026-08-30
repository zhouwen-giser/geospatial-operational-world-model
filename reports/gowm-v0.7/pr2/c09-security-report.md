# Security report

Status: `PASS` (`P2-X01` through `P2-X03`)

SQL assertion 051 and the real-DB negative gate passed 11 fail-closed checks:
cross-scope Tracklet, segment, watermark, source selection, effective snapshot
and artifact access; missing artifact; forged historical reference; same source
record conflict; public idempotency-conflict mapping; and generic fail-closed
behavior. Append-only revision writes and stale worker generations were rejected.

Command: `npm.cmd run validate:world-platform-final`; cwd:
`<local-worktree>/gowm-v07-pr2`;
UTC `2026-08-30T09:42:29.022Z`–`2026-08-30T09:44:12.3010375Z`; exit 0;
commit `91e1f030369cd91a8a29308d4ba89bc0339e29f0`; real DB versions 18.6 / 3.6.4 / 1.3.0.
Output excerpt: `GOWM_V07_PR2_GATE_PASS history-security`.
