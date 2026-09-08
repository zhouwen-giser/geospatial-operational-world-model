CREATE UNIQUE INDEX temporary_skill_experience_once_idx ON ugv_sdar.temporary_skill_experience (temporary_skill_id);

CREATE FUNCTION ugv_sdar.finalize_task_temporary_skills() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.phase NOT IN ('completed','failed','canceled','invalidated','capability_gap') THEN RETURN NEW; END IF;
  WITH expired AS (
    UPDATE temporary_skill SET status='expired',expired_at=NEW.updated_at
    WHERE task_id=NEW.task_id AND status='active' RETURNING *
  )
  INSERT INTO temporary_skill_experience(experience_id,temporary_skill_id,task_id,context_id,
    capability_fingerprint,successful,outcome_summary,created_at)
  SELECT 'temporary-terminal:'||length(NEW.task_id)::text||':'||NEW.task_id||':'||temporary_skill_id,
    temporary_skill_id,task_id,context_id,capability_fingerprint,
    COALESCE(NEW.phase='completed' AND NEW.temporary_skill_id=temporary_skill_id AND NEW.error_code IS NULL
      AND (NEW.output_text IS NOT NULL OR NEW.output_structured IS NOT NULL),false),
    NEW.phase||': '||NEW.phase_message,NEW.updated_at
  FROM expired ON CONFLICT(temporary_skill_id) DO NOTHING;
  RETURN NEW;
END $$ SET search_path TO ugv_sdar, public, pg_catalog;

CREATE TRIGGER agent_task_finalize_temporary_skills
  AFTER INSERT OR UPDATE OF phase
  ON ugv_sdar.agent_task
  FOR EACH ROW
  EXECUTE PROCEDURE finalize_task_temporary_skills();

CREATE FUNCTION ugv_sdar.reject_temporary_skill_after_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_phase text;
BEGIN
  IF NEW.status='active' THEN
    SELECT phase INTO owner_phase FROM agent_task WHERE task_id=NEW.task_id FOR UPDATE;
    IF owner_phase IN ('completed','failed','canceled','invalidated','capability_gap')
      THEN RAISE EXCEPTION 'TEMPORARY_SKILL_TASK_ALREADY_TERMINAL'; END IF;
  END IF;
  RETURN NEW;
END $$ SET search_path TO ugv_sdar, public, pg_catalog;

CREATE TRIGGER temporary_skill_reject_terminal_owner
  BEFORE INSERT OR UPDATE
  ON ugv_sdar.temporary_skill
  FOR EACH ROW
  EXECUTE PROCEDURE reject_temporary_skill_after_terminal();

WITH 
expired AS (UPDATE ugv_sdar.temporary_skill AS skill SET status = 'expired',expired_at = task.updated_at FROM ugv_sdar.agent_task AS task WHERE task.task_id = skill.task_id
  AND skill.status = 'active'
  AND task.phase IN ('completed', 'failed', 'canceled', 'invalidated', 'capability_gap') RETURNING skill.*) INSERT INTO ugv_sdar.temporary_skill_experience (
  experience_id,
  temporary_skill_id,
  task_id,
  context_id,
  capability_fingerprint,
  successful,
  outcome_summary,
  created_at
) SELECT
  (((('temporary-terminal:' || (length(task_id))::text) || ':') || task_id) || ':') || temporary_skill_id,
  temporary_skill_id,
  task_id,
  context_id,
  capability_fingerprint,
  false,
  'Historical terminal Task: execution success was not independently proven.',
  expired_at
FROM expired ON CONFLICT (temporary_skill_id) DO NOTHING;

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0181_v14_temporary_skill_terminal');
