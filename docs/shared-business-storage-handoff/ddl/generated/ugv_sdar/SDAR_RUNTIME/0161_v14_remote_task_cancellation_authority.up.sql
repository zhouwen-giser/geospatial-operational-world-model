ALTER TABLE ugv_sdar.remote_task_binding 
  ADD COLUMN task_cancellation text;

UPDATE ugv_sdar.remote_task_binding SET task_cancellation = 'unknown' WHERE task_cancellation IS NULL;

ALTER TABLE ugv_sdar.remote_task_binding 
  ALTER COLUMN task_cancellation SET NOT NULL,
  ADD CONSTRAINT remote_task_binding_task_cancellation_check 
    CHECK (task_cancellation IN ('unsupported', 'cooperative', 'task_cancel', 'unknown') IS TRUE);

UPDATE ugv_sdar.remote_task_admission_intent SET remote_receipt_json = jsonb_set(remote_receipt_json, '{taskCancellation}', '"unknown"'::jsonb, true) WHERE remote_receipt_json IS NOT NULL
  AND NOT (remote_receipt_json ? 'taskCancellation');

ALTER TABLE ugv_sdar.remote_task_admission_intent 
  ADD CONSTRAINT remote_task_admission_receipt_cancellation_authority_check 
    CHECK (
    remote_receipt_json IS NULL
      OR remote_receipt_json ->> 'taskCancellation' IN ('unsupported', 'cooperative', 'task_cancel', 'unknown') IS TRUE
  );

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0161_v14_remote_task_cancellation_authority');
