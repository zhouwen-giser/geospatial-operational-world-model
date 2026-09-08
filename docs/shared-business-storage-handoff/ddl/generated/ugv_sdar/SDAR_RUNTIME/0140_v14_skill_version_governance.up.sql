CREATE TABLE IF NOT EXISTS ugv_sdar.runtime_skill_version_governance (
  skill_id text NOT NULL,
  skill_version int NOT NULL CHECK (skill_version > 0),
  lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('draft', 'validated', 'published', 'suspended', 'deprecated', 'retired')),
  lock_version bigint NOT NULL CHECK (lock_version >= 0),
  updated_by text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (skill_id, skill_version),
  FOREIGN KEY(skill_id, skill_version)
    REFERENCES ugv_sdar.skill_version (skill_id, version)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS ugv_sdar.runtime_skill_governance_command (
  command_id text PRIMARY KEY,
  operation_type text NOT NULL CHECK (operation_type IN ('skill.publish', 'skill.suspend', 'skill.deprecate')),
  skill_id text NOT NULL,
  skill_version int NOT NULL CHECK (skill_version > 0),
  idempotency_key_hash char(64) NOT NULL CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
  result_revision bigint NOT NULL CHECK (result_revision > 0),
  result_status text NOT NULL CHECK (result_status IN ('draft', 'validated', 'published', 'suspended', 'deprecated', 'retired')),
  actor_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (operation_type, idempotency_key_hash),
  FOREIGN KEY(skill_id, skill_version)
    REFERENCES ugv_sdar.skill_version (skill_id, version)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS runtime_skill_governance_command_target_idx ON ugv_sdar.runtime_skill_governance_command (skill_id, skill_version, created_at DESC);

CREATE OR REPLACE FUNCTION ugv_sdar.reject_runtime_skill_governance_command_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'RUNTIME_SKILL_GOVERNANCE_COMMAND_IMMUTABLE' USING ERRCODE = '55000';
END;
$$ SET search_path TO ugv_sdar, public, pg_catalog;

DROP TRIGGER IF EXISTS runtime_skill_governance_command_immutable ON runtime_skill_governance_command;

CREATE TRIGGER runtime_skill_governance_command_immutable
  BEFORE DELETE OR UPDATE
  ON ugv_sdar.runtime_skill_governance_command
  FOR EACH ROW
  EXECUTE PROCEDURE reject_runtime_skill_governance_command_mutation();

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0140_v14_skill_version_governance');
