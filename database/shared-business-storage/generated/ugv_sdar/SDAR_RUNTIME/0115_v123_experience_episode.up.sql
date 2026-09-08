DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM goal_experience_episode)
     OR EXISTS (SELECT 1 FROM experience_job)
     OR EXISTS (SELECT 1 FROM experience_dead_letter) THEN
    RAISE EXCEPTION 'MIGRATION_0115_REQUIRES_EMPTY_UNRELEASED_EXPERIENCE_DATA';
  END IF;
END $$;

ALTER TABLE ugv_sdar.goal_experience_episode 
  ADD COLUMN task_id text
    REFERENCES ugv_sdar.agent_task (task_id),
  ADD COLUMN context_id text
    NOT NULL
    REFERENCES ugv_sdar.conversation_context (context_id),
  ADD COLUMN episode_type text
    NOT NULL
    CHECK (episode_type IN ('terminal', 'revision', 'interaction', 'recovery')),
  ADD COLUMN terminal_outcome_ref text
    NOT NULL
    UNIQUE
    REFERENCES ugv_sdar.runtime_terminal_outcome (outcome_id),
  ADD COLUMN source_hash text
    NOT NULL
    CHECK (source_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN status text
    NOT NULL
    CHECK (status IN ('partial', 'complete')),
  ADD COLUMN tenant_id text,
  ADD COLUMN user_scope_id text,
  ADD CONSTRAINT goal_experience_episode_contract_fk
    FOREIGN KEY(goal_id, goal_version)
    REFERENCES ugv_sdar.user_goal_contract (goal_id, goal_version);

CREATE INDEX goal_experience_episode_task_idx ON ugv_sdar.goal_experience_episode (task_id, created_at DESC, episode_id);

CREATE INDEX goal_experience_episode_scope_idx ON ugv_sdar.goal_experience_episode (tenant_id, user_scope_id, created_at DESC, episode_id);

ALTER TABLE ugv_sdar.experience_job 
  ADD COLUMN source_event_id text
    UNIQUE
    REFERENCES ugv_sdar.cognitive_runtime_outbox (event_id),
  ADD COLUMN result_ref text,
  ADD CONSTRAINT experience_job_payload_size_check 
    CHECK (octet_length(payload::text) <= 65536);

ALTER TABLE ugv_sdar.experience_dead_letter 
  ADD CONSTRAINT experience_dead_letter_error_summary_size_check 
    CHECK (length(error_summary) BETWEEN 1 AND 2048);

CREATE INDEX experience_job_expired_lease_idx ON ugv_sdar.experience_job (lease_expires_at, job_id) WHERE status = 'leased';

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0115_v123_experience_episode');
