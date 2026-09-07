# Historical original-evidence read contract 2.0

`gowm_history_v2.read_trajectory_samples(reference text, revision integer,
captured_at timestamptz, limit integer DEFAULT 1000, cursor jsonb DEFAULT NULL)`
is the additive, Scope-bound, read-only contract. It is not an HTTP endpoint.
Call it inside the same read-only repeatable-read transaction as the historical
revision and the downstream analysis snapshot. Use `gowm_history_v1.set_data_scope`
on that transaction. Only grant `gowm_history_reader`; do not grant source-table
write privileges to analysis services.

## Identity and completeness

The function verifies the immutable TRACKLET_VERSION content hashes and rebuilds
the exact TRACKLET_INPUT_SET and TIME_SOLUTION_SET canonical digests pinned by
the revision. `captured_at` is an access cutoff, not a substitute for membership.
No newest-time-solution, newest-position, geometry-node or missing-lineage fallback
is permitted. `evidenceCapturedAt` is the original analysis cutoff.

The page returns `contractVersion=2.0`, `sampleSemantics=ORIGINAL_MEASUREMENT_V1`,
`revisionId`, `contentHash`, `inputSetHash`, `trackletInputSetHash`,
`timeSolutionSetHash`, `evidenceHash`, `evidenceCapturedAt`, `samples`,
`evidenceSampleCount`, `geometryNodeCount`, `previewPointCount`, `complete` and
`nextCursor`. The evidence hash is an independent digest; it never replaces an
old revision's content hash. Analysis snapshots include it as a pinned resource.

Each sample carries measurement/observation/time-solution IDs, source tracklet
version, source segment and ordinal, solved event timestamp, uncertainty and
clock-model ID, WGS84 position/CRS, source/session/local-target identity, quality,
received timestamp, source-record/revision and continuity evidence. Raw payloads
are deliberately not exposed. The measurement ID is the stable sample ID.

Page order is historical segment, source ordinal, measurement ID. Opaque cursors
bind revision and evidence hash; clients must not fabricate or reuse them for a
different revision. Clients debit their budget by actual samples, not JSON rows.
`complete=false` is not a complete trajectory. Missing or incompatible contracts,
page drift, inconsistent counts and exhausted budgets must stop analysis.
The server caps pinned input membership at 100,000 rows before digest aggregation;
larger requests fail explicitly, not by truncation.

## Geometry and endpoints

Evidence samples, compressed geometry nodes and preview points are distinct
quantities. A stationary 197-measurement sequence may have two geometry nodes.
Interpolated boundaries are not measurements and do not qualify STOP counts.
Task/request/phase clipping is half-open. The source segment's last measured
instant remains eligible when it lies inside that requested half-open interval,
even when the legacy geometry range has an open upper bound. Original-source
endpoint reproduction and a request ending exactly on that endpoint consequently
have different counts; do not silently compare these two conventions.

New projections use `trajectory-single-authoritative-v2/2.0` and algorithm 2.0.
Old v1 profiles, serialized responses, revision hashes and cached results are not
rewritten. The v2 reader can recover an old revision only if its fixed lineage
validates. Analysis implementation identities change independently and old
geometry-sample caches cannot be reused.

## Errors

Scope/reference/capture mismatch: `TRAJECTORY_NOT_FOUND`.
Missing or inconsistent fixed evidence: `EVIDENCE_*` (fail closed).
Invalid cursor: `EVIDENCE_CURSOR_MISMATCH` / `EVIDENCE_CURSOR_OUT_OF_RANGE`.
Oversized pinned membership: `EVIDENCE_READ_BUDGET_EXCEEDED`.
Normal pagination is not an error; clients must finish it within their budget.
