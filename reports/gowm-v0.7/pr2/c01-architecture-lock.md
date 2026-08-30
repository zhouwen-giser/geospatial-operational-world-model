# PR-2 architecture lock

Status: `IMPLEMENTED_AND_VERIFIED_PREVIEW`

- Phenomenon time orders history; received time records lateness and audit.
- Operational events, interval revisions, Tracklet Versions, finalization
  revisions and historical analyses are append-only.
- Explicit gaps remain gaps; no segment is interpolated across them.
- Requested and Effective Snapshots remain separate, persisted logical
  resource-version manifests.
- Scope is checked before reads and controlled writes.
- Worker generation/fence and compare-and-swap checks prevent stale overwrite.
- Providers do not call Providers directly. One Gateway submission owns the
  interval-to-history DAG and passes the node output reference unchanged.
- Historical source selection is single-authoritative and fail-closed; no hidden
  multi-source fusion occurs.
- Late data appends new versions while exact old pinned replay remains possible.
- Historical operations remain `PREVIEW`.

Excluded: Map Matching, junction/crossing semantics, communication-location
ranking, multi-source fusion, route/GDPS composition, WSGS/SACS/SDAR changes,
production deployment and production SLO/HA/PITR qualification.
