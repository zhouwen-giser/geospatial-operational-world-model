BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_gateway_service') THEN
    CREATE ROLE gowm_gateway_service NOLOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_gateway_registry_service') THEN
    CREATE ROLE gowm_gateway_registry_service NOLOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_spatial_service') THEN
    CREATE ROLE gowm_spatial_service NOLOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_situation_reader') THEN
    CREATE ROLE gowm_situation_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_situation_service') THEN
    CREATE ROLE gowm_situation_service NOLOGIN INHERIT;
  END IF;
END
$roles$;

GRANT gowm_gateway_runtime TO gowm_gateway_service;
GRANT gowm_gateway_registry_admin TO gowm_gateway_registry_service;
GRANT spatial_provider TO gowm_spatial_service;

GRANT USAGE ON SCHEMA public TO gowm_situation_reader;
GRANT SELECT ON
  data_scope,
  gowm_deployment_config,
  situation_cell_scored,
  world_object,
  world_object_state,
  world_object_geometry,
  world_reference_identity
TO gowm_situation_reader;
GRANT SELECT ON SEQUENCE world_version_seq TO gowm_situation_reader;
GRANT gowm_situation_reader TO gowm_situation_service;

ALTER ROLE gowm_spatial_service SET default_transaction_read_only = on;
ALTER ROLE gowm_spatial_service SET statement_timeout = '30s';
ALTER ROLE gowm_situation_service SET default_transaction_read_only = on;
ALTER ROLE gowm_situation_service SET statement_timeout = '15s';

COMMENT ON ROLE gowm_gateway_service IS
  'NOLOGIN until deployment provisioning; Gateway runtime persistence only.';
COMMENT ON ROLE gowm_gateway_registry_service IS
  'NOLOGIN until deployment provisioning; short-lived controlled Registry bootstrap only.';
COMMENT ON ROLE gowm_spatial_service IS
  'NOLOGIN until deployment provisioning; inherits the gowm_spatial_v1 read-only contract.';
COMMENT ON ROLE gowm_situation_service IS
  'NOLOGIN until deployment provisioning; pinned single-scope Situation read access only.';

-- Migration 013 only claimed QUEUED work. Preserve its signature while adding
-- bounded recovery for RUNNING jobs whose lease (or legacy update grace) has
-- expired after a Gateway process restart.
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

  -- Queue time consumes the persisted plan budget. Expired work is made
  -- terminal before selection and can never receive a short live lease.
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
           -- A live worker needs no heartbeat: its lease covers the bounded
           -- plan deadline plus shutdown grace, preventing concurrent reclaim.
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
    INSERT INTO gowm_capability.gateway_job_state_transition (
      job_id, from_state, to_state, reason_code, actor_kind
    )
    SELECT updated.job_id, updated.from_state, 'RUNNING',
           CASE WHEN updated.from_state = 'RUNNING' THEN 'ASYNC_LEASE_RECOVERY' ELSE 'ASYNC_CLAIM' END,
           'SYSTEM'
    FROM updated
    RETURNING job_id
  )
  SELECT updated.job_id, query_job.query_id
  FROM updated
  JOIN transition USING (job_id)
  JOIN gowm_capability.world_query_job query_job USING (job_id);
END
$fn$;

REVOKE ALL ON FUNCTION gowm_capability.claim_world_query_job(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_capability.claim_world_query_job(text, integer) TO gowm_gateway_runtime;

COMMIT;
