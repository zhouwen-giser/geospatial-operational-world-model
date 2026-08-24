# C00 Source Reconciliation

## Decision

`PASS`

The Capability Platform v0.2 implementation is represented by the committed and
pushed SHA `1887e56a18b77aa9692cca9d86b00413906816f4`. The local branch, fetched
remote branch, and Draft PR #1 head agree exactly.

## Reconciled source state

| Item | Observed state |
|---|---|
| Repository | `zhouwen-giser/geospatial-operational-world-model` |
| Branch | `codex/gowm-capability-platform-v0.2` |
| Local HEAD | `1887e56a18b77aa9692cca9d86b00413906816f4` |
| Remote HEAD | `1887e56a18b77aa9692cca9d86b00413906816f4` |
| PR #1 head | `1887e56a18b77aa9692cca9d86b00413906816f4` |
| PR #1 base | `codex/unify-gowm-stas-v0.1.0` |
| PR state | `OPEN`, `Draft`, `MERGEABLE` |
| Baseline | `d1ff3b81b8bf577965b00edc1bd06acaaeda706c` |
| Package-generation head | `1887e56a18b77aa9692cca9d86b00413906816f4` |

The fetched branch has not advanced since package generation. The sole
untracked path at reconciliation time is
`GOWM_Grounding_Operational_Stable_v0.4_Codex_Goal/`, created by extracting the
operator-supplied task package for this goal. No pre-existing tracked or
untracked work was stashed, reset, overwritten, or removed.

## Stale-state finding

`PROJECT_STATUS.md`, `reports/capability-platform-v0.2/p17-final-candidate-completion.md`,
and `reports/capability-platform-v0.2/p17-final-candidate-acceptance.json` still
describe the implementation as an uncommitted working tree at `e100cc0`. Git
history now shows that the implementation and the later security validation
were committed and pushed through `1887e56`. Those historical reports are
retained; C01 will append the correction and update the current project status.

This reconciliation does not promote any missing live PostgreSQL, external
Provider, Docker, scope, DAG, or restart evidence. Those gates remain subject to
C02 execution.

## Commands and evidence

| Command | Result |
|---|---|
| `git fetch --all --prune` | PASS |
| `git status --short` | PASS; only extracted task package is untracked |
| `git rev-parse HEAD` | `1887e56a18b77aa9692cca9d86b00413906816f4` |
| `git rev-parse origin/codex/gowm-capability-platform-v0.2` | same SHA |
| `gh pr view 1 --json ...` | OPEN Draft PR, matching head, mergeable |
| `bash scripts/preflight.sh .` in task package | `PREFLIGHT_PASS` |
| system Python task-package validation | FAILED: `jsonschema` 3.2 lacks Draft 2020-12 |
| bundled Python task-package validation | FAILED: `jsonschema` absent |
| isolated `/tmp` Python validator | `TASK_PACKAGE_VALID schemas=27 providers=4 examples=8 acceptance=140` |

## Acceptance

- AC-C001: PASS — local, remote, and PR head were freshly reconciled.
- AC-C002: PASS — no existing worktree state was taken or rewritten.

## Protected actions

No merge, tag, release, deployment, rebase, force-push, reset, or stash was
performed.
