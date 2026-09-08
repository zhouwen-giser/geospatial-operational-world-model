CREATE TABLE IF NOT EXISTS ugv_sdar.generalized_pattern (
  generalized_pattern_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  domain text NOT NULL,
  task_type_id text NOT NULL,
  source_fused_pattern_ref text NOT NULL,
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  generalizer_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generalized_pattern_lookup ON ugv_sdar.generalized_pattern (tenant_id, task_type_id);

CREATE TABLE IF NOT EXISTS ugv_sdar.candidate_fingerprint (
  fingerprint text PRIMARY KEY,
  artifact_type text NOT NULL,
  domain text NOT NULL,
  task_type_id text NOT NULL,
  artifact_ref text NOT NULL,
  generator_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidate_fingerprint_lookup ON ugv_sdar.candidate_fingerprint (artifact_type, domain, task_type_id);

CREATE TABLE IF NOT EXISTS ugv_sdar.candidate_static_validation (
  validation_id text PRIMARY KEY,
  artifact_ref text NOT NULL,
  schema_valid boolean NOT NULL,
  dag_valid boolean NOT NULL,
  required_criteria_covered boolean NOT NULL,
  capability_shape_valid boolean NOT NULL,
  parameter_policy_valid boolean NOT NULL,
  side_effect_replay_safe boolean NOT NULL,
  bounds_valid boolean NOT NULL,
  duplicate_fingerprint text,
  errors jsonb NOT NULL DEFAULT '[]',
  warnings jsonb NOT NULL DEFAULT '[]',
  validator_version text NOT NULL,
  result text NOT NULL CHECK (result IN ('passed_static', 'failed_static')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidate_validation_artifact ON ugv_sdar.candidate_static_validation (artifact_ref);

CREATE TABLE IF NOT EXISTS ugv_sdar.candidate_generation_run (
  run_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  source_pattern_ref text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  result_artifact_ref text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_candidate_generation_run_status ON ugv_sdar.candidate_generation_run (tenant_id, status);

CREATE TABLE IF NOT EXISTS ugv_sdar.candidate_model_invocation (
  invocation_id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES ugv_sdar.candidate_generation_run (run_id)
    ON DELETE CASCADE,
  model_id text NOT NULL,
  prompt_hash text NOT NULL,
  input_hash text NOT NULL,
  output_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidate_model_invocation_run ON ugv_sdar.candidate_model_invocation (run_id);

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0127_v13_artifact_candidate_generation') ON CONFLICT (version) DO NOTHING;
