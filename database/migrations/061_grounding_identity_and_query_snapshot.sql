BEGIN;

ALTER TABLE gowm_capability.world_query_job
  ADD COLUMN query_snapshot_manifest jsonb,
  ADD COLUMN principal_context jsonb;

UPDATE gowm_capability.world_query_job
SET query_snapshot_manifest = jsonb_build_object(
      'querySnapshotId', 'snapshot_legacy_' || substr(encode(digest(query_id, 'sha256'), 'hex'), 1, 32),
      'mode', 'BEST_EFFORT',
      'consistency', 'BEST_EFFORT',
      'capturedAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'resources', '[]'::jsonb,
      'manifestHash', 'sha256:' || encode(digest(query_id || ':legacy-best-effort', 'sha256'), 'hex')
    ),
    principal_context = jsonb_strip_nulls(jsonb_build_object(
      'mode', 'STATIC_SERVICE',
      'principalRef', principal_ref,
      'servicePrincipalRef', principal_ref,
      'actorRef', principal_ref,
      'authenticationMethod', authentication_method,
      'authenticatedAt', to_char(authenticated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'dataScopeClaim', data_scope_claim,
      'datasetScopeClaim', dataset_scope_claim,
      'effectiveDataScopes', CASE WHEN data_scope_claim IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(data_scope_claim) END,
      'effectiveDatasetScopes', CASE WHEN dataset_scope_claim IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(dataset_scope_claim) END,
      'allowExperimental', allow_experimental
    ));

ALTER TABLE gowm_capability.world_query_job
  ALTER COLUMN query_snapshot_manifest SET NOT NULL,
  ALTER COLUMN principal_context SET NOT NULL,
  ADD CONSTRAINT world_query_job_snapshot_manifest_object CHECK (
    jsonb_typeof(query_snapshot_manifest) = 'object'
    AND query_snapshot_manifest->>'querySnapshotId' IS NOT NULL
    AND query_snapshot_manifest->>'manifestHash' ~ '^sha256:[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT world_query_job_principal_context_object CHECK (
    jsonb_typeof(principal_context) = 'object'
    AND principal_context->>'principalRef' = principal_ref
    AND principal_context->>'authenticationMethod' = authentication_method
  );

COMMENT ON COLUMN gowm_capability.world_query_job.query_snapshot_manifest IS
  'Logical resource-version snapshot constraints; never a cross-process PostgreSQL MVCC snapshot.';
COMMENT ON COLUMN gowm_capability.world_query_job.principal_context IS
  'Effective Gateway principal. Raw bearer and delegation tokens are never persisted.';

COMMIT;
