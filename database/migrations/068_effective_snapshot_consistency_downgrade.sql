BEGIN;

-- Migration 063 intentionally froze the caller-requested snapshot scope, but
-- it also required Effective Snapshot consistency to remain byte-for-byte
-- equal to the requested consistency.  That prevented an explicitly
-- authorized BEST_EFFORT downgrade from being persisted.  Keep every scope
-- boundary frozen while allowing only the documented weaker consistency
-- levels relative to the caller's request.
ALTER TABLE gowm_capability.world_query_job
  DROP CONSTRAINT world_query_job_effective_scope_preserved;

CREATE OR REPLACE FUNCTION gowm_capability.effective_snapshot_scope_preserved(
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
    AND CASE p_requested->>'consistency'
      WHEN 'PINNED' THEN p_effective->>'consistency' IN (
        'PINNED', 'CONSISTENT_AT_START', 'BEST_EFFORT'
      )
      WHEN 'CONSISTENT_AT_START' THEN p_effective->>'consistency' IN (
        'CONSISTENT_AT_START', 'BEST_EFFORT'
      )
      WHEN 'BEST_EFFORT' THEN p_effective->>'consistency' = 'BEST_EFFORT'
      ELSE false
    END
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
  ADD CONSTRAINT world_query_job_effective_scope_preserved CHECK (
    gowm_capability.effective_snapshot_scope_preserved(
      query_snapshot_manifest,
      effective_snapshot_manifest
    )
  ) NOT VALID;

ALTER TABLE gowm_capability.world_query_job
  VALIDATE CONSTRAINT world_query_job_effective_scope_preserved;

-- The scope CHECK above proves that every Effective Snapshot is no stronger
-- than the caller-requested Snapshot.  It cannot compare two successive row
-- versions, however.  Keep the persisted Effective Snapshot monotonic as the
-- DAG advances: once execution has degraded consistency, a retry or resumed
-- worker must not strengthen the claim without re-running prior nodes.
CREATE FUNCTION gowm_capability.enforce_effective_snapshot_consistency_monotonic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
DECLARE
  previous_rank integer;
  next_rank integer;
BEGIN
  previous_rank := CASE OLD.effective_snapshot_manifest->>'consistency'
    WHEN 'PINNED' THEN 3
    WHEN 'CONSISTENT_AT_START' THEN 2
    WHEN 'BEST_EFFORT' THEN 1
    ELSE NULL
  END;
  next_rank := CASE NEW.effective_snapshot_manifest->>'consistency'
    WHEN 'PINNED' THEN 3
    WHEN 'CONSISTENT_AT_START' THEN 2
    WHEN 'BEST_EFFORT' THEN 1
    ELSE NULL
  END;

  -- The existing effective Snapshot object CHECK remains authoritative for
  -- malformed or unknown consistency values.  This trigger adds only the
  -- transition rule that a row CHECK cannot express.
  IF previous_rank IS NOT NULL
     AND next_rank IS NOT NULL
     AND next_rank > previous_rank THEN
    RAISE EXCEPTION 'effective snapshot consistency cannot be strengthened'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'world_query_job_effective_consistency_monotonic';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER world_query_job_effective_consistency_monotonic
  BEFORE UPDATE OF effective_snapshot_manifest
  ON gowm_capability.world_query_job
  FOR EACH ROW
  WHEN (OLD.effective_snapshot_manifest IS DISTINCT FROM NEW.effective_snapshot_manifest)
  EXECUTE FUNCTION gowm_capability.enforce_effective_snapshot_consistency_monotonic();

REVOKE ALL ON FUNCTION gowm_capability.enforce_effective_snapshot_consistency_monotonic()
  FROM PUBLIC;

COMMENT ON FUNCTION gowm_capability.effective_snapshot_scope_preserved(jsonb, jsonb) IS
  'Preserves query identity, mode, minimum world version, and DATA_SCOPE membership while allowing Effective Snapshot consistency to be equal to or weaker than requested.';

COMMENT ON FUNCTION gowm_capability.enforce_effective_snapshot_consistency_monotonic() IS
  'Rejects Effective Snapshot updates that strengthen consistency relative to the previously persisted row version.';

COMMIT;
