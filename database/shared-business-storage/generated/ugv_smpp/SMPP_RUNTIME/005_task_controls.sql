ALTER TABLE ugv_smpp.provider_task 
  ADD COLUMN next_command_sequence bigint
    NOT NULL
    DEFAULT 0
    CHECK (next_command_sequence >= 0);

ALTER TABLE ugv_smpp.task_input_request 
  ADD COLUMN description text
    NOT NULL
    DEFAULT '',
  ADD COLUMN required boolean
    NOT NULL
    DEFAULT true;

CREATE TABLE ugv_smpp.task_command (
  task_id uuid NOT NULL REFERENCES ugv_smpp.provider_task (task_id)
    ON DELETE CASCADE,
  command_sequence bigint NOT NULL CHECK (command_sequence > 0),
  command_type text NOT NULL CHECK (command_type IN ('CANCEL', 'UPDATE', 'PAUSE', 'RESUME')),
  request_hash char(64) NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING', 'ACKNOWLEDGED', 'REJECTED')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  adapter_ack jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id, command_sequence),
  UNIQUE (task_id, command_type, request_hash)
);

CREATE INDEX task_command_pending_idx ON ugv_smpp.task_command (created_at) WHERE state = 'PENDING';
