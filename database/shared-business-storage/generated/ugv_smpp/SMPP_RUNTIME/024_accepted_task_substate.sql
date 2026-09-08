ALTER TABLE ugv_smpp.provider_task 
  DROP CONSTRAINT provider_task_substate_check RESTRICT,
  ADD CONSTRAINT provider_task_substate_check 
    CHECK (substate IN ('accepted', 'scheduled', 'queued', 'running', 'paused', 'resuming', 'stopping'));
