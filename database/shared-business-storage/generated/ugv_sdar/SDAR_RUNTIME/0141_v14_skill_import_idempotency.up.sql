CREATE TABLE ugv_sdar.runtime_skill_import_command (
  command_id text PRIMARY KEY,
  idempotency_key_hash char(64) NOT NULL UNIQUE CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  package_root text NOT NULL CHECK (length(package_root) BETWEEN 1 AND 4096),
  package_checksum char(64) NOT NULL CHECK (package_checksum ~ '^[a-f0-9]{64}$'),
  skill_id text NOT NULL,
  skill_version int NOT NULL CHECK (skill_version > 0),
  status text NOT NULL CHECK (status IN ('pending', 'succeeded')),
  actor_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK (
    (status = 'pending'
      AND completed_at IS NULL)
      OR (status = 'succeeded'
      AND completed_at IS NOT NULL)
  )
);

CREATE INDEX runtime_skill_import_command_target_idx ON ugv_sdar.runtime_skill_import_command (skill_id, skill_version, created_at DESC);

CREATE FUNCTION ugv_sdar.enforce_runtime_skill_import_command_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RUNTIME_SKILL_IMPORT_COMMAND_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD.command_id <> NEW.command_id
     OR OLD.idempotency_key_hash <> NEW.idempotency_key_hash
     OR OLD.request_hash <> NEW.request_hash
     OR OLD.package_root <> NEW.package_root
     OR OLD.package_checksum <> NEW.package_checksum
     OR OLD.skill_id <> NEW.skill_id
     OR OLD.skill_version <> NEW.skill_version
     OR OLD.actor_id <> NEW.actor_id
     OR OLD.reason <> NEW.reason
     OR OLD.created_at <> NEW.created_at
     OR OLD.status <> 'pending'
     OR NEW.status <> 'succeeded'
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'RUNTIME_SKILL_IMPORT_COMMAND_INVALID_TRANSITION' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ SET search_path TO ugv_sdar, public, pg_catalog;

CREATE TRIGGER runtime_skill_import_command_transition
  BEFORE DELETE OR UPDATE
  ON ugv_sdar.runtime_skill_import_command
  FOR EACH ROW
  EXECUTE PROCEDURE enforce_runtime_skill_import_command_transition();

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0141_v14_skill_import_idempotency');
