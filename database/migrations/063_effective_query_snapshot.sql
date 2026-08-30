BEGIN;

-- query_snapshot_manifest remains the caller-requested logical resource
-- constraints.  The effective manifest is a separately versioned, durable
-- record of the resources actually pinned while the DAG executes.
ALTER TABLE gowm_capability.world_query_job
  ADD COLUMN effective_snapshot_manifest jsonb,
  ADD COLUMN effective_snapshot_revision integer,
  ADD COLUMN effective_snapshot_updated_at timestamptz;

-- Migration 061 synthesized a bounded BEST_EFFORT manifest for rows that
-- predated query snapshots, but its placeholder hash was a provenance marker
-- over query_id rather than the canonical manifest content.  Recognize only
-- that exact legacy shape and source identity, then repair the hash before it
-- becomes both the requested and initial effective snapshot.  Runtime hash
-- validation can therefore remain strict for every persisted row.
CREATE FUNCTION gowm_capability.canonical_legacy_query_snapshot_hash(p_manifest jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $fn$
  SELECT CASE
    WHEN jsonb_typeof(p_manifest) = 'object'
      AND p_manifest->>'querySnapshotId' ~ '^snapshot_legacy_[0-9a-f]{32}$'
      AND p_manifest->>'mode' = 'BEST_EFFORT'
      AND p_manifest->>'consistency' = 'BEST_EFFORT'
      AND length(p_manifest->>'capturedAt') > 0
      AND p_manifest->'resources' = '[]'::jsonb
      AND p_manifest->>'manifestHash' ~ '^sha256:[0-9a-f]{64}$'
      AND p_manifest = jsonb_build_object(
        'querySnapshotId', p_manifest->>'querySnapshotId',
        'mode', 'BEST_EFFORT',
        'consistency', 'BEST_EFFORT',
        'capturedAt', p_manifest->>'capturedAt',
        'resources', '[]'::jsonb,
        'manifestHash', p_manifest->>'manifestHash'
      )
    THEN 'sha256:' || encode(public.digest(
      '{"capturedAt":' || to_jsonb(p_manifest->>'capturedAt')::text
      || ',"consistency":"BEST_EFFORT"'
      || ',"mode":"BEST_EFFORT"'
      || ',"querySnapshotId":' || to_jsonb(p_manifest->>'querySnapshotId')::text
      || ',"resources":[]}',
      'sha256'
    ), 'hex')
    ELSE NULL
  END
$fn$;

UPDATE gowm_capability.world_query_job
SET query_snapshot_manifest = jsonb_set(
  query_snapshot_manifest,
  '{manifestHash}',
  to_jsonb(gowm_capability.canonical_legacy_query_snapshot_hash(query_snapshot_manifest)),
  false
)
WHERE query_snapshot_manifest->>'querySnapshotId' =
      'snapshot_legacy_' || substr(encode(public.digest(query_id, 'sha256'), 'hex'), 1, 32)
  AND query_snapshot_manifest->>'manifestHash' =
      'sha256:' || encode(public.digest(query_id || ':legacy-best-effort', 'sha256'), 'hex')
  AND gowm_capability.canonical_legacy_query_snapshot_hash(query_snapshot_manifest) IS NOT NULL;

UPDATE gowm_capability.world_query_job
SET effective_snapshot_manifest = query_snapshot_manifest,
    effective_snapshot_revision = 0,
    effective_snapshot_updated_at = COALESCE(updated_at, created_at);

CREATE FUNCTION gowm_capability.effective_snapshot_scope_preserved(
  p_requested jsonb,
  p_effective jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $fn$
  SELECT
    jsonb_typeof(p_requested->'resources') = 'array'
    AND jsonb_typeof(p_effective->'resources') = 'array'
    AND p_effective->>'querySnapshotId' = p_requested->>'querySnapshotId'
    AND p_effective->>'mode' = p_requested->>'mode'
    AND p_effective->>'consistency' = p_requested->>'consistency'
    AND (p_effective->'minimumWorldVersion') IS NOT DISTINCT FROM
        (p_requested->'minimumWorldVersion')
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_effective->'resources') AS effective_resource(value)
      WHERE effective_resource.value->>'resourceKind' = 'DATA_SCOPE'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(p_requested->'resources') AS requested_resource(value)
          WHERE requested_resource.value->>'resourceKind' = 'DATA_SCOPE'
            AND requested_resource.value->>'resourceId' = effective_resource.value->>'resourceId'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_requested->'resources') AS requested_resource(value)
      WHERE requested_resource.value->>'resourceKind' = 'DATA_SCOPE'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(p_effective->'resources') AS effective_resource(value)
          WHERE effective_resource.value->>'resourceKind' = 'DATA_SCOPE'
            AND effective_resource.value->>'resourceId' = requested_resource.value->>'resourceId'
        )
    )
$fn$;

ALTER TABLE gowm_capability.world_query_job
  ALTER COLUMN effective_snapshot_manifest SET NOT NULL,
  ALTER COLUMN effective_snapshot_revision SET NOT NULL,
  ALTER COLUMN effective_snapshot_revision SET DEFAULT 0,
  ALTER COLUMN effective_snapshot_updated_at SET NOT NULL,
  ALTER COLUMN effective_snapshot_updated_at SET DEFAULT clock_timestamp(),
  ADD CONSTRAINT world_query_job_effective_snapshot_object CHECK (
    jsonb_typeof(effective_snapshot_manifest) = 'object'
    AND effective_snapshot_manifest->'resources' IS NOT NULL
    AND jsonb_typeof(effective_snapshot_manifest->'resources') = 'array'
    AND jsonb_array_length(effective_snapshot_manifest->'resources') <= 512
    AND effective_snapshot_manifest->>'querySnapshotId' IS NOT NULL
    AND length(btrim(effective_snapshot_manifest->>'querySnapshotId')) BETWEEN 1 AND 256
    AND effective_snapshot_manifest->>'mode' IN (
      'LATEST_AT_START','PINNED','AT_LEAST_WORLD_VERSION','BEST_EFFORT'
    )
    AND effective_snapshot_manifest->>'consistency' IN (
      'PINNED','CONSISTENT_AT_START','BEST_EFFORT'
    )
    AND effective_snapshot_manifest->>'manifestHash' IS NOT NULL
    AND effective_snapshot_manifest->>'manifestHash' ~ '^sha256:[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT world_query_job_effective_revision_nonnegative CHECK (
    effective_snapshot_revision >= 0
  ),
  ADD CONSTRAINT world_query_job_effective_timestamp_order CHECK (
    effective_snapshot_updated_at >= created_at
  ),
  ADD CONSTRAINT world_query_job_effective_scope_preserved CHECK (
    gowm_capability.effective_snapshot_scope_preserved(
      query_snapshot_manifest,
      effective_snapshot_manifest
    )
  );

COMMENT ON COLUMN gowm_capability.world_query_job.query_snapshot_manifest IS
  'Caller-requested logical resource-version constraints. This is not a cross-process PostgreSQL MVCC snapshot.';
COMMENT ON COLUMN gowm_capability.world_query_job.effective_snapshot_manifest IS
  'Durable logical resource versions actually pinned while executing the query DAG; not a PostgreSQL MVCC snapshot.';
COMMENT ON COLUMN gowm_capability.world_query_job.effective_snapshot_revision IS
  'Monotonic application CAS revision for the effective logical resource snapshot.';
COMMENT ON COLUMN gowm_capability.world_query_job.effective_snapshot_updated_at IS
  'Database time at which the effective logical resource snapshot was last committed.';

REVOKE ALL ON FUNCTION gowm_capability.effective_snapshot_scope_preserved(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION gowm_capability.canonical_legacy_query_snapshot_hash(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_capability.effective_snapshot_scope_preserved(jsonb, jsonb)
  TO gowm_gateway_runtime;
GRANT UPDATE (
  effective_snapshot_manifest,
  effective_snapshot_revision,
  effective_snapshot_updated_at,
  updated_at
) ON gowm_capability.world_query_job TO gowm_gateway_runtime;

COMMIT;
