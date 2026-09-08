ALTER TABLE ugv_sdar.remote_task_binding 
  DROP CONSTRAINT remote_task_binding_provider_substate_check RESTRICT;

ALTER TABLE ugv_sdar.remote_task_binding 
  ADD CONSTRAINT remote_task_binding_provider_substate_check 
    CHECK (
    provider_substate IS NULL
      OR provider_substate IN ('accepted', 'scheduled', 'queued', 'running', 'paused', 'resuming', 'stopping')
  );

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0173_remote_task_accepted_substate');
