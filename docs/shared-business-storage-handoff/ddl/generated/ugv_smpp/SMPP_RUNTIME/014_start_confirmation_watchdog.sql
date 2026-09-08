ALTER TABLE ugv_smpp.provider_task 
  DROP CONSTRAINT provider_task_internal_state_check RESTRICT,
  ADD CONSTRAINT provider_task_internal_state_check 
    CHECK (internal_state IN ('SCHEDULED', 'STARTING', 'WAITING_START_CONFIRMATION', 'QUEUED', 'RUNNING', 'PAUSED', 'RESUMING', 'INPUT_REQUIRED', 'STOPPING', 'TERMINAL_COMPLETED', 'TERMINAL_FAILED', 'TERMINAL_CANCELLED')),
  ADD COLUMN start_confirmation_deadline timestamptz,
  ADD COLUMN start_confirmation_attempts int
    NOT NULL
    DEFAULT 0
    CHECK (start_confirmation_attempts >= 0);

UPDATE ugv_smpp.provider_task SET start_confirmation_deadline = latest_start_at WHERE external_execution_id IS NOT NULL
  AND actual_started_at IS NULL;

CREATE INDEX provider_task_start_confirmation_due_idx ON ugv_smpp.provider_task (start_confirmation_deadline, schedule_claim_until, task_id) WHERE external_execution_id IS NOT NULL
  AND actual_started_at IS NULL
  AND internal_state NOT LIKE 'TERMINAL_%';
