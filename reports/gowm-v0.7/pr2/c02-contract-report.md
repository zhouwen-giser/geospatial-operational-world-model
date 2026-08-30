# PR-2 contract report

Status: `PASS`

`npm.cmd run validate:world-platform-regression` passed all 14 command gates on
exact source fingerprint `sha256:9a2b4f1629845fc3d7d3807d12baa75f1715c672f3aea2e62abfd7a53404507b`.
Contract generation, TypeScript checks, SQL AST verification, frozen legacy
contracts, boundaries, semantic catalog, registry, consumer bundles and Provider
conformance all passed. The v0.7 catalog contains 16 Providers and 124 unique
operations; `operational-task.get-execution-intervals@1.0` and
`history.get-trajectory@1.0` are additive and `PREVIEW`.

Evidence window: UTC `2026-08-30T09:40:09.957Z` through
`2026-08-30T09:41:59.8406536Z`; exact shell start was not persisted, so the
start is the earliest retained command-log timestamp. Exit code 0. Working
directory: `<local-worktree>/gowm-v07-pr2`.
Artifact: `world-platform/regression/report.json` (`sha256:22f607cc0d4fb2c8cd90f0d6cc89d0a3cbc131807baf047ac0bbb1abc790d708`).
