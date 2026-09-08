BEGIN;
CREATE FUNCTION gowm_history.renew_historical_trajectory_projection(
  p_queue_id uuid, p_worker_id text, p_generation bigint, p_lease interval
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
BEGIN
  IF p_lease IS NULL OR p_lease <= interval '0' OR p_lease > interval '15 minutes' THEN
    RAISE EXCEPTION 'historical trajectory renewal lease is invalid' USING ERRCODE='22023';
  END IF;
  UPDATE gowm_history.historical_trajectory_projection_queue
  SET lease_until=clock_timestamp()+p_lease
  WHERE queue_id=p_queue_id AND state='RUNNING'
    AND locked_by=p_worker_id AND generation=p_generation
    AND lease_until>clock_timestamp();
  RETURN FOUND;
END
$fn$;
REVOKE ALL ON FUNCTION gowm_history.renew_historical_trajectory_projection(uuid,text,bigint,interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_history.renew_historical_trajectory_projection(uuid,text,bigint,interval) TO gowm_history_worker;
COMMENT ON FUNCTION gowm_history.renew_historical_trajectory_projection(uuid,text,bigint,interval) IS
 'Only a live worker/generation fence can renew. Expired, reclaimed or completed claims cannot be resurrected; frozen payloads and completion checks are unchanged.';
COMMIT;
