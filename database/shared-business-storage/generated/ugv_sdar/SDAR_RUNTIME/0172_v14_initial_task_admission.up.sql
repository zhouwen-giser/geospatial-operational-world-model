CREATE TABLE ugv_sdar.initial_task_admission (
  idempotency_key text PRIMARY KEY CHECK (char_length(idempotency_key) BETWEEN 1 AND 256) CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  task_id text NOT NULL UNIQUE REFERENCES ugv_sdar.agent_task (task_id)
    ON DELETE RESTRICT,
  context_id text NOT NULL REFERENCES ugv_sdar.conversation_context (context_id)
    ON DELETE RESTRICT,
  capability_binding_id text NOT NULL UNIQUE,
  capability_attempt_id text NOT NULL UNIQUE,
  created_context boolean NOT NULL,
  accepted_at timestamptz NOT NULL,
  FOREIGN KEY(capability_binding_id, task_id)
    REFERENCES ugv_sdar.task_capability_binding (binding_id, task_id)
    ON DELETE RESTRICT,
  FOREIGN KEY(capability_attempt_id, task_id)
    REFERENCES ugv_sdar.task_capability_execution_attempt (attempt_id, task_id)
    ON DELETE RESTRICT
);

CREATE INDEX initial_task_admission_context_idx ON ugv_sdar.initial_task_admission (context_id, accepted_at, task_id);

CREATE FUNCTION ugv_sdar.prevent_initial_task_admission_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'INITIAL_TASK_ADMISSION_IMMUTABLE' USING ERRCODE='55000';
END $$ SET search_path TO ugv_sdar, public, pg_catalog;

CREATE TRIGGER initial_task_admission_immutable
  BEFORE DELETE OR UPDATE
  ON ugv_sdar.initial_task_admission
  FOR EACH ROW
  EXECUTE PROCEDURE prevent_initial_task_admission_mutation();

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0172_v14_initial_task_admission');
