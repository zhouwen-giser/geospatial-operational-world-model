CREATE TABLE IF NOT EXISTS ugv_sdar.fused_pattern (
  fused_pattern_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  workflow_pattern_id text NOT NULL,
  source_process_pattern_ref text NOT NULL REFERENCES ugv_sdar.pattern_candidate (pattern_id),
  source_trace_refs jsonb NOT NULL CHECK (
    jsonb_typeof(source_trace_refs) = 'array'
      AND jsonb_array_length(source_trace_refs) > 0
  ),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  fusion_version text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fused_pattern_source ON ugv_sdar.fused_pattern (tenant_id, source_process_pattern_ref, workflow_pattern_id);

ALTER TABLE ugv_sdar.candidate_generation_run 
  ADD COLUMN IF NOT EXISTS source_event_id text,
  ADD COLUMN IF NOT EXISTS attempt int
    NOT NULL
    DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts int
    NOT NULL
    DEFAULT 5,
  ADD COLUMN IF NOT EXISTS available_at timestamptz
    NOT NULL
    DEFAULT now(),
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_token text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS payload jsonb
    NOT NULL
    DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS last_error_summary text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz
    NOT NULL
    DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz
    NOT NULL
    DEFAULT now();

UPDATE ugv_sdar.candidate_generation_run SET idempotency_key = COALESCE(idempotency_key, 'legacy:' || run_id),available_at = COALESCE(available_at, started_at),created_at = COALESCE(created_at, started_at),updated_at = COALESCE(updated_at, completed_at, started_at);

ALTER TABLE ugv_sdar.candidate_generation_run 
  ALTER COLUMN idempotency_key SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'candidate_generation_run_status_check'
  ) THEN
    ALTER TABLE candidate_generation_run
      ADD CONSTRAINT candidate_generation_run_status_check
      CHECK (status IN ('pending','leased','retry_wait','completed','dead_letter'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_candidate_generation_run_idempotency ON ugv_sdar.candidate_generation_run (idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_candidate_generation_run_source_event ON ugv_sdar.candidate_generation_run (source_event_id) WHERE source_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_candidate_generation_run_requeue ON ugv_sdar.candidate_generation_run (status, available_at, run_id);

ALTER TABLE ugv_sdar.candidate_static_validation 
  ADD COLUMN IF NOT EXISTS activity_identity_valid boolean
    NOT NULL
    DEFAULT false,
  ADD COLUMN IF NOT EXISTS parallel_semantics_valid boolean
    NOT NULL
    DEFAULT false,
  ADD COLUMN IF NOT EXISTS capability_catalog_aligned boolean
    NOT NULL
    DEFAULT false,
  ADD COLUMN IF NOT EXISTS parameter_schema_aligned boolean
    NOT NULL
    DEFAULT false,
  ADD COLUMN IF NOT EXISTS applicability_evaluable boolean
    NOT NULL
    DEFAULT false,
  ADD COLUMN IF NOT EXISTS lineage_complete boolean
    NOT NULL
    DEFAULT false,
  ADD COLUMN IF NOT EXISTS recovery_semantics_valid boolean
    NOT NULL
    DEFAULT false;

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0128_v13_candidate_generation_runtime') ON CONFLICT (version) DO NOTHING;
