# PR-1 architecture lock

PR-1 separates caller-requested snapshot constraints from a persisted Effective
Snapshot expanded only by descriptor-authorized resource discovery. Node result
and Effective Snapshot changes commit atomically under CAS and execution fence.
Workers reload the persisted expansion after process restart. Compatibility
fallbacks preserve old requests, descriptors and results.

Generic analysis resource inputs and deterministic input sets are platform-owned,
scope-before-read, controlled-write and append-only. Snapshot manifests are
logical resource-version constraints, not shared database MVCC snapshots.

This PR prepublishes contracts but does not implement intervals, Tracklet
finalization, Historical Trace, Map Matching, crossing semantics or ranking.
