DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM task_capability_execution_attempt AS attempt
      JOIN mcp_invocation AS invocation ON invocation.task_id=attempt.task_id
     WHERE attempt.status IN ('prepared','running','waiting')
       AND attempt.attempt_no=(
         SELECT MAX(latest.attempt_no)
           FROM task_capability_execution_attempt AS latest
          WHERE latest.task_id=attempt.task_id
       )
  ) THEN
    RAISE EXCEPTION 'CAPABILITY_ATTEMPT_LINEAGE_MIGRATION_REQUIRES_RECONCILIATION'
      USING ERRCODE='55000';
  END IF;
END $$;

ALTER TABLE ugv_sdar.task_capability_execution_attempt 
  ADD CONSTRAINT task_capability_attempt_identity_unique 
    UNIQUE (attempt_id, task_id);

ALTER TABLE ugv_sdar.mcp_invocation 
  ADD COLUMN capability_attempt_id text,
  ADD CONSTRAINT mcp_invocation_capability_attempt_task_check 
    CHECK (
    capability_attempt_id IS NULL
      OR task_id IS NOT NULL
  ),
  ADD CONSTRAINT mcp_invocation_capability_attempt_fk
    FOREIGN KEY(capability_attempt_id, task_id)
    REFERENCES ugv_sdar.task_capability_execution_attempt (attempt_id, task_id)
    ON DELETE RESTRICT;

CREATE INDEX mcp_invocation_capability_attempt_idx ON ugv_sdar.mcp_invocation (capability_attempt_id, started_at, invocation_id) WHERE capability_attempt_id IS NOT NULL;

ALTER TABLE ugv_sdar.runtime_terminal_outcome 
  ADD COLUMN capability_attempt_id text,
  ADD CONSTRAINT runtime_terminal_outcome_capability_attempt_task_check 
    CHECK (
    capability_attempt_id IS NULL
      OR task_id IS NOT NULL
  ),
  ADD CONSTRAINT runtime_terminal_outcome_capability_attempt_fk
    FOREIGN KEY(capability_attempt_id, task_id)
    REFERENCES ugv_sdar.task_capability_execution_attempt (attempt_id, task_id)
    ON DELETE RESTRICT;

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0151_v14_capability_attempt_evidence_lineage');
