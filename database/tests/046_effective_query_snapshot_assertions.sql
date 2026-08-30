\set ON_ERROR_STOP on

DO $assert$
DECLARE
  requested jsonb := '{
    "querySnapshotId":"snapshot_database_assertion",
    "mode":"PINNED",
    "consistency":"PINNED",
    "capturedAt":"2026-01-01T00:00:00.000Z",
    "resources":[{
      "resourceKind":"DATA_SCOPE",
      "resourceId":"gowm:scope-a",
      "version":"1",
      "pinning":"PINNED"
    }],
    "manifestHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }'::jsonb;
  effective jsonb;
  legacy jsonb := '{
    "querySnapshotId":"snapshot_legacy_0123456789abcdef0123456789abcdef",
    "mode":"BEST_EFFORT",
    "consistency":"BEST_EFFORT",
    "capturedAt":"2026-08-30T12:34:56.789Z",
    "resources":[],
    "manifestHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }'::jsonb;
  snapshot_comment text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'gowm_capability'
      AND table_name = 'world_query_job'
      AND column_name = 'effective_snapshot_manifest'
      AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'gowm_capability'
      AND table_name = 'world_query_job'
      AND column_name = 'effective_snapshot_revision'
      AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'gowm_capability'
      AND table_name = 'world_query_job'
      AND column_name = 'effective_snapshot_updated_at'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'effective query snapshot persistence columns are incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gowm_capability.world_query_job
    WHERE effective_snapshot_manifest IS NULL
       OR effective_snapshot_revision < 0
       OR effective_snapshot_updated_at < created_at
  ) THEN
    RAISE EXCEPTION 'effective snapshot backfill or invariants are incomplete';
  END IF;

  IF gowm_capability.canonical_legacy_query_snapshot_hash(legacy) <>
     'sha256:ba840fc9a6d959f378efba6212ea986621fb0c9c257c5e7ddd851560820c0e89' THEN
    RAISE EXCEPTION 'migration 061 legacy manifest canonicalization differs from the runtime hash';
  END IF;
  IF gowm_capability.canonical_legacy_query_snapshot_hash(
    legacy || '{"unexpected":true}'::jsonb
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'legacy snapshot repair accepted a manifest with an unknown field';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gowm_capability.world_query_job job
    WHERE job.query_snapshot_manifest->>'querySnapshotId' =
          'snapshot_legacy_' || substr(encode(public.digest(job.query_id, 'sha256'), 'hex'), 1, 32)
      AND job.query_snapshot_manifest->>'manifestHash' =
          'sha256:' || encode(public.digest(job.query_id || ':legacy-best-effort', 'sha256'), 'hex')
  ) THEN
    RAISE EXCEPTION 'migration 061 non-canonical manifest hash remains after upgrade';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM gowm_capability.world_query_job job
    WHERE gowm_capability.canonical_legacy_query_snapshot_hash(
            job.query_snapshot_manifest
          ) IS NOT NULL
      AND job.query_snapshot_manifest->>'manifestHash' <>
          gowm_capability.canonical_legacy_query_snapshot_hash(job.query_snapshot_manifest)
  ) THEN
    RAISE EXCEPTION 'upgraded legacy requested manifest does not carry its canonical hash';
  END IF;

  effective := jsonb_set(
    requested,
    '{resources}',
    (requested->'resources') || '[{
      "resourceKind":"TRACKLET_VERSION",
      "resourceId":"gowm:tracklet-a",
      "version":"1",
      "pinning":"PINNED"
    }]'::jsonb
  );
  IF NOT gowm_capability.effective_snapshot_scope_preserved(requested, effective) THEN
    RAISE EXCEPTION 'effective snapshot rejected an ordinary discovered resource';
  END IF;

  effective := jsonb_set(
    requested,
    '{resources}',
    (requested->'resources') || '[{
      "resourceKind":"DATA_SCOPE",
      "resourceId":"gowm:scope-b",
      "version":"1",
      "pinning":"PINNED"
    }]'::jsonb
  );
  IF gowm_capability.effective_snapshot_scope_preserved(requested, effective) THEN
    RAISE EXCEPTION 'effective snapshot allowed data scope expansion';
  END IF;

  SELECT col_description(
    'gowm_capability.world_query_job'::regclass,
    attnum
  )
  INTO snapshot_comment
  FROM pg_attribute
  WHERE attrelid = 'gowm_capability.world_query_job'::regclass
    AND attname = 'effective_snapshot_manifest';
  IF snapshot_comment IS NULL OR snapshot_comment NOT ILIKE '%not a PostgreSQL MVCC snapshot%' THEN
    RAISE EXCEPTION 'effective snapshot MVCC boundary is undocumented';
  END IF;

  IF NOT has_column_privilege(
    'gowm_gateway_runtime',
    'gowm_capability.world_query_job',
    'effective_snapshot_manifest',
    'UPDATE'
  ) OR has_column_privilege(
    'gowm_gateway_runtime',
    'gowm_capability.world_query_job',
    'query_snapshot_manifest',
    'UPDATE'
  ) THEN
    RAISE EXCEPTION 'requested/effective snapshot mutation privileges are incorrect';
  END IF;
END
$assert$;

SELECT 'EFFECTIVE_QUERY_SNAPSHOT_ASSERTIONS_PASS' AS result;
