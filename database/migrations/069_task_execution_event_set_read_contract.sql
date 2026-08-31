BEGIN;

-- The execution-interval projection stores the event-set hash that produced
-- each immutable interval revision.  A query at capturedAt also needs the
-- independently computed hash of every task event visible at that boundary so
-- projection lag cannot make an old interval input set look current.
CREATE FUNCTION gowm_history_v1.task_execution_event_set_as_of(
  p_task_reference_key text,
  p_captured_at timestamptz
)
RETURNS TABLE(
  event_set_hash text,
  event_count bigint,
  max_world_version bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history_v1
AS $fn$
  WITH scoped_task AS (
    SELECT task.operational_task_id
    FROM public.operational_task task
    WHERE task.data_scope_key = gowm_history_v1.current_data_scope_key()
      AND task.reference_key = p_task_reference_key
  ),
  visible_event AS (
    SELECT
      event.operational_task_id,
      event.event_time,
      event.received_time,
      event.source_authority,
      event.source_event_key,
      event.source_revision_no,
      event.event_id,
      event.content_hash,
      event.world_version
    FROM public.operational_task_event event
    JOIN scoped_task task USING (operational_task_id)
    WHERE event.data_scope_key = gowm_history_v1.current_data_scope_key()
      AND event.created_at <= p_captured_at
  )
  SELECT
    public.grounding_sha256(COALESCE((jsonb_agg(
      jsonb_build_array(
        event.event_time,
        event.received_time,
        event.source_authority,
        event.source_event_key,
        event.source_revision_no,
        event.event_id,
        event.content_hash
      ) ORDER BY
        event.event_time,
        event.received_time,
        event.source_authority,
        event.source_event_key,
        event.source_revision_no,
        event.event_id
    ) FILTER (WHERE event.event_id IS NOT NULL))::text, '[]')) AS event_set_hash,
    count(event.event_id) AS event_count,
    max(event.world_version) AS max_world_version
  FROM scoped_task task
  LEFT JOIN visible_event event USING (operational_task_id)
  GROUP BY task.operational_task_id
$fn$;

REVOKE ALL ON FUNCTION gowm_history_v1.task_execution_event_set_as_of(text, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_history_v1.task_execution_event_set_as_of(text, timestamptz)
  TO gowm_history_reader;

COMMENT ON FUNCTION gowm_history_v1.task_execution_event_set_as_of(text, timestamptz) IS
  'Returns the scoped, capturedAt-bounded current task event-set hash using the same canonical event fields and ordering as interval projection.';

COMMIT;
