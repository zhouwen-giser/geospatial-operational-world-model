BEGIN;

-- Migration 014 added bounded restart recovery to the World Query claim
-- function.  Qualify the transition RETURNING column so PostgreSQL does not
-- confuse it with the function's RETURNS TABLE output parameter named job_id.
CREATE OR REPLACE FUNCTION gowm_capability.claim_world_query_job(
  p_worker text,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE(job_id uuid, query_id text)
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'worker identity is required' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'lease seconds must be between 1 and 3600' USING ERRCODE = '22023';
  END IF;

  WITH expired AS (
    UPDATE gowm_capability.gateway_job g
       SET state = 'TIMED_OUT',
           completed_at = clock_timestamp(),
           failure_code = 'DEADLINE_EXCEEDED',
           lease_owner = NULL,
           lease_until = NULL,
           updated_at = clock_timestamp()
     WHERE g.job_kind = 'WORLD_QUERY'
       AND g.state = 'QUEUED'
       AND g.deadline_at <= clock_timestamp()
    RETURNING g.job_id
  )
  INSERT INTO gowm_capability.gateway_job_state_transition (
    job_id, from_state, to_state, reason_code, actor_kind
  )
  SELECT expired.job_id, 'QUEUED', 'TIMED_OUT', 'QUEUE_DEADLINE_EXPIRED', 'SYSTEM'
  FROM expired;

  RETURN QUERY
  WITH candidate AS (
    SELECT g.job_id, g.state AS from_state
    FROM gowm_capability.gateway_job g
    WHERE g.job_kind = 'WORLD_QUERY'
      AND g.cancellation_requested_at IS NULL
      AND (
        (g.state = 'QUEUED' AND g.deadline_at > clock_timestamp())
        OR (
          g.state = 'RUNNING'
          AND GREATEST(
            COALESCE(g.lease_until, g.updated_at + make_interval(secs => p_lease_seconds)),
            COALESCE(g.deadline_at + interval '30 seconds', g.updated_at + make_interval(secs => p_lease_seconds))
          ) <= clock_timestamp()
        )
      )
    ORDER BY CASE WHEN g.state = 'RUNNING' THEN 0 ELSE 1 END,
             g.priority DESC, g.created_at, g.job_id
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  ), updated AS (
    UPDATE gowm_capability.gateway_job g
       SET state = 'RUNNING',
           lease_owner = p_worker,
           lease_until = GREATEST(
             clock_timestamp() + make_interval(secs => p_lease_seconds),
             COALESCE(g.deadline_at + interval '30 seconds', clock_timestamp())
           ),
           started_at = COALESCE(g.started_at, clock_timestamp()),
           attempt_count = g.attempt_count + 1,
           updated_at = clock_timestamp()
      FROM candidate c
     WHERE g.job_id = c.job_id
    RETURNING g.job_id, c.from_state
  ), transition AS (
    INSERT INTO gowm_capability.gateway_job_state_transition AS inserted_transition (
      job_id, from_state, to_state, reason_code, actor_kind
    )
    SELECT updated.job_id, updated.from_state, 'RUNNING',
           CASE WHEN updated.from_state = 'RUNNING' THEN 'ASYNC_LEASE_RECOVERY' ELSE 'ASYNC_CLAIM' END,
           'SYSTEM'
    FROM updated
    RETURNING inserted_transition.job_id AS transitioned_job_id
  )
  SELECT updated.job_id, query_job.query_id
  FROM updated
  JOIN transition ON transition.transitioned_job_id = updated.job_id
  JOIN gowm_capability.world_query_job query_job ON query_job.job_id = updated.job_id;
END
$fn$;

REVOKE ALL ON FUNCTION gowm_capability.claim_world_query_job(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_capability.claim_world_query_job(text, integer) TO gowm_gateway_runtime;

COMMIT;
