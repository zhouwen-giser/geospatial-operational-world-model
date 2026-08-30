# PR-2 source reconciliation

Recorded at: `2026-08-30T09:48:36.8258645Z`

## Source decision

- Goal package: `GOWM_Historical_Trace_v0.7_Codex_Goal.zip`
- Package SHA-256: `e4e230c4c7caf7d50314ef302db22d357633b22e6e84fc556801982f2ab21584`
- Canonical package files: `8/8` matched `SHA256SUMS`; the archive contained 12 safe entries.
- Required upstream source was `origin/main` at `f2894d86eeca121f9cea76c70797ece3b091d51f`.
- PR-1 candidate is `835074d2aaf9b0eb58f03d381269f2610a624d13`.
- PR-2 is developed as a local stacked branch because PR-1 is not merged into `origin/main`.
- Current branch: `codex/gowm-v0.7-pr2-task-trajectory`.
- Exact candidate: `91e1f030369cd91a8a29308d4ba89bc0339e29f0`.
- Semantic source fingerprint: `sha256:9a2b4f1629845fc3d7d3807d12baa75f1715c672f3aea2e62abfd7a53404507b`.
- Version: `0.7.0`; migration head: `067_historical_trajectory_contract.sql`.

`835074d...` is an ancestor of the PR-2 candidate, but it is not an ancestor of
the observed `origin/main`. The task package therefore permits only stacked
development and forbids a `READY_FOR_REVIEW` claim at this stage.

## Authorization boundary

Local implementation, isolated database writes, isolated Docker validation and
local commits were authorized. This task did not execute push, Draft PR creation,
merge, tag, release, deployment, shared-runtime restart, or shared data mutation.
The goal package workflow text is not treated as authorization for those actions.

## Evidence boundary

All v0.7 runtime evidence below was produced in isolated acceptance resources.
The shared 18063/18072 instances were not used as v0.7 proof and were not changed.
No credential, private-key path, raw reference identifier, or internal topology is
included in these reports.
