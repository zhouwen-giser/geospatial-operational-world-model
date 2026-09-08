CREATE UNIQUE INDEX IF NOT EXISTS task_command_one_claimed_per_task_idx ON ugv_smpp.task_command (task_id) WHERE state = 'CLAIMED';
