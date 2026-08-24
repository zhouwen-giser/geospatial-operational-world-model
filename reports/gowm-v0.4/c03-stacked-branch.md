# C03 Stacked Branch

## Decision

`PASS`

The continuation branch `codex/gowm-grounding-operational-v0.4-stable` was
created from exact local and remote v0.2 candidate
`99c56b4e095222b1a4120ff5d49f39c3cb6ea43d` and pushed without rewriting the
base branch.

The stacked Pull Request base is
`codex/gowm-capability-platform-v0.2`. It remains Draft and user-controlled.
No merge, tag, release, or deployment was performed.

## Historical gate state

At C03 execution AC-C007 and AC-C008 were blocked because the immutable prior
CRS, Geometry, Spatial POC archives and H3 Toolkit revision were unavailable.
The later 2026-08-24 release-owner policy override records both as PASS without
claiming runtime execution.

## Acceptance

- AC-C011: PASS — the continuation branch begins at the exact pushed v0.2
  candidate.
- AC-C012: PASS — both base and continuation delivery remain Draft/unmerged and
  under user control.
