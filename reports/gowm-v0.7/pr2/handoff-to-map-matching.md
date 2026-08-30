# Handoff inputs for a future Map Matching task

This document defines inputs only. It does not implement or qualify Map Matching.

- Historical Trajectory Reference: exact scope, identity and immutable revision.
- Task Interval Reference: exact interval revision and execution/phase lineage.
- Tracklet Version set: single-authoritative source/session, immutable versions.
- Gap set: explicit known and unknown gaps; never bridge them implicitly.
- Effective Snapshot: requested constraints plus runtime-discovered exact pins.
- Analysis evidence: append-only resource inputs and deterministic input-set digest.

Consumers must preserve scope-before-read, exact pinned replay, captured-at
isolation, source ambiguity fail-closed behavior and PREVIEW maturity. A future
Map Matching implementation must append its own versioned analysis and must not
rewrite Tracklets, intervals, finalization revisions or historical trajectories.
