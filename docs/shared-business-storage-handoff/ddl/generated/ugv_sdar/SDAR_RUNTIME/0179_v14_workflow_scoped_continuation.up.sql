ALTER TABLE ugv_sdar.workflow_continuation_snapshot 
  DROP CONSTRAINT workflow_continuation_snapshot_schema_version_check RESTRICT;

ALTER TABLE ugv_sdar.workflow_continuation_snapshot 
  ADD CONSTRAINT workflow_continuation_snapshot_schema_version_check 
    CHECK (schema_version IN ('1.0', '2.0')),
  ADD CONSTRAINT workflow_continuation_snapshot_scopes_check 
    CHECK (
    (schema_version = '1.0'
      AND NOT (state_json ? 'scopes'))
      OR (schema_version = '2.0'
      AND state_json ? 'scopes'
      AND jsonb_typeof(state_json -> 'scopes') = 'object')
  );

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='workflow_continuation_attempt'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%claimed%'
  LOOP
    EXECUTE format('ALTER TABLE workflow_continuation_attempt DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE ugv_sdar.workflow_continuation_attempt 
  ADD CONSTRAINT workflow_continuation_attempt_status_check 
    CHECK (status IN ('claimed', 'running', 'paused', 'waiting_external', 'succeeded', 'failed', 'canceled', 'stale')),
  ADD CONSTRAINT workflow_continuation_attempt_handoff_check 
    CHECK (
    (status = 'claimed'
      AND started_at IS NULL
      AND completed_at IS NULL
      AND error_code IS NULL)
      OR (status = 'running'
      AND started_at IS NOT NULL
      AND completed_at IS NULL)
      OR (status IN ('paused', 'waiting_external', 'succeeded', 'canceled')
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND error_code IS NULL)
      OR (status = 'stale'
      AND completed_at IS NOT NULL
      AND error_code IS NULL)
      OR (status = 'failed'
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND length(btrim(error_code)) > 0)
  );

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0179_v14_workflow_scoped_continuation');
