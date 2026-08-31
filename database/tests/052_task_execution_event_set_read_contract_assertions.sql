\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.data_scope(scope_key, operational_domain, description) VALUES
  ('history-event-set-a', 'TEST', 'Task event-set assertion scope A'),
  ('history-event-set-b', 'TEST', 'Task event-set assertion scope B');

INSERT INTO public.world_reference_identity(
  reference_key, entity_kind, internal_id, data_scope_key
) VALUES
  (
    'wrf_69000000000000000000000000000011',
    'OPERATIONAL_TASK',
    'history-event-set-task-a',
    'history-event-set-a'
  ),
  (
    'wrf_69000000000000000000000000000012',
    'OPERATIONAL_TASK',
    'history-event-set-task-b',
    'history-event-set-b'
  );

INSERT INTO public.operational_task(
  data_scope_key, operational_task_id, reference_key
) VALUES
  (
    'history-event-set-a',
    'history-event-set-task-a',
    'wrf_69000000000000000000000000000011'
  ),
  (
    'history-event-set-b',
    'history-event-set-task-b',
    'wrf_69000000000000000000000000000012'
  );

INSERT INTO public.operational_task_event(
  data_scope_key, event_id, operational_task_id, event_type, event_time,
  received_time, subject_reference_key, actor_reference_keys,
  target_reference_keys, payload, confidence, provenance, world_version,
  source_authority, source_event_key, source_revision_no,
  arrival_classification, projection_disposition, content_hash, created_at
) VALUES
  (
    'history-event-set-a', 'history-event-set-a-1', 'history-event-set-task-a',
    'EXECUTION_STARTED_OBSERVED', '2026-08-31T00:00:00Z',
    '2026-08-31T00:00:01Z', NULL, '[]', '[]', '{}', 1,
    '[{"authority":"history-event-set-assertion"}]', 6901,
    'history-event-set-assertion', 'event-a-1', 1, 'CURRENT', 'PENDING',
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    '2026-08-31T01:00:00Z'
  ),
  (
    'history-event-set-a', 'history-event-set-a-2', 'history-event-set-task-a',
    'EXECUTION_PROGRESS_OBSERVED', '2026-08-31T00:00:02Z',
    '2026-08-31T00:00:03Z', NULL, '[]', '[]', '{}', 0.9,
    '[{"authority":"history-event-set-assertion"}]', 6902,
    'history-event-set-assertion', 'event-a-2', 1, 'CURRENT', 'PENDING',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    '2026-08-31T02:00:00Z'
  ),
  (
    'history-event-set-b', 'history-event-set-b-1', 'history-event-set-task-b',
    'EXECUTION_STARTED_OBSERVED', '2026-08-31T00:00:04Z',
    '2026-08-31T00:00:05Z', NULL, '[]', '[]', '{}', 1,
    '[{"authority":"history-event-set-assertion"}]', 6991,
    'history-event-set-assertion', 'event-b-1', 1, 'CURRENT', 'PENDING',
    'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    '2026-08-31T01:00:00Z'
  );

DO $event_set_contract$
DECLARE
  first_boundary constant timestamptz := '2026-08-31T01:30:00Z';
  current_boundary constant timestamptz := '2026-08-31T03:00:00Z';
  first_result record;
  current_result record;
  scope_b_result record;
  expected_first_hash text;
  expected_current_hash text;
  function_security_definer boolean;
  function_volatility "char";
BEGIN
  SELECT procedure.prosecdef, procedure.provolatile
  INTO STRICT function_security_definer, function_volatility
  FROM pg_proc procedure
  JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'gowm_history_v1'
    AND procedure.proname = 'task_execution_event_set_as_of'
    AND procedure.oid = to_regprocedure(
      'gowm_history_v1.task_execution_event_set_as_of(text,timestamptz)'
    );

  IF NOT function_security_definer OR function_volatility <> 's' THEN
    RAISE EXCEPTION 'task event-set function is not STABLE SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege(
       'gowm_history_reader',
       'gowm_history_v1.task_execution_event_set_as_of(text,timestamptz)',
       'EXECUTE'
     ) OR has_function_privilege(
       'gowm_history_writer',
       'gowm_history_v1.task_execution_event_set_as_of(text,timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'task event-set function role grants are incorrect';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc procedure
    CROSS JOIN LATERAL aclexplode(COALESCE(
      procedure.proacl,
      acldefault('f', procedure.proowner)
    )) acl
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'gowm_history_v1'
      AND procedure.proname = 'task_execution_event_set_as_of'
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC retained EXECUTE on the task event-set function';
  END IF;
  IF NOT pg_has_role(
       'gowm_operational_service', 'gowm_history_reader', 'member'
     ) THEN
    RAISE EXCEPTION 'operational provider does not inherit the history reader role';
  END IF;

  PERFORM set_config('gowm.data_scope_key', '', true);
  IF EXISTS (
    SELECT 1
    FROM gowm_history_v1.task_execution_event_set_as_of(
      'wrf_69000000000000000000000000000011',
      current_boundary
    )
  ) THEN
    RAISE EXCEPTION 'task event set was visible before scope selection';
  END IF;

  PERFORM set_config('gowm.data_scope_key', 'history-event-set-a', true);
  SELECT * INTO STRICT first_result
  FROM gowm_history_v1.task_execution_event_set_as_of(
    'wrf_69000000000000000000000000000011',
    first_boundary
  );
  SELECT * INTO STRICT current_result
  FROM gowm_history_v1.task_execution_event_set_as_of(
    'wrf_69000000000000000000000000000011',
    current_boundary
  );

  SELECT public.grounding_sha256(jsonb_agg(jsonb_build_array(
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
    event.event_id)::text)
  INTO STRICT expected_first_hash
  FROM public.operational_task_event event
  WHERE event.data_scope_key = 'history-event-set-a'
    AND event.operational_task_id = 'history-event-set-task-a'
    AND event.created_at <= first_boundary;

  SELECT public.grounding_sha256(jsonb_agg(jsonb_build_array(
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
    event.event_id)::text)
  INTO STRICT expected_current_hash
  FROM public.operational_task_event event
  WHERE event.data_scope_key = 'history-event-set-a'
    AND event.operational_task_id = 'history-event-set-task-a'
    AND event.created_at <= current_boundary;

  IF first_result.event_set_hash IS DISTINCT FROM expected_first_hash
     OR first_result.event_count IS DISTINCT FROM 1::bigint
     OR first_result.max_world_version IS DISTINCT FROM 6901::bigint THEN
    RAISE EXCEPTION 'capturedAt-bounded task event set is not canonical';
  END IF;
  IF current_result.event_set_hash IS DISTINCT FROM expected_current_hash
     OR current_result.event_count IS DISTINCT FROM 2::bigint
     OR current_result.max_world_version IS DISTINCT FROM 6902::bigint THEN
    RAISE EXCEPTION 'current visible task event set is not canonical';
  END IF;
  IF first_result.event_set_hash = current_result.event_set_hash THEN
    RAISE EXCEPTION 'task event-set hash did not advance with the visible event set';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM gowm_history_v1.task_execution_event_set_as_of(
      'wrf_690000000000000000000000000000ff',
      current_boundary
    )
  ) THEN
    RAISE EXCEPTION 'unknown task reference returned an event set';
  END IF;

  PERFORM set_config('gowm.data_scope_key', 'history-event-set-b', true);
  IF EXISTS (
    SELECT 1
    FROM gowm_history_v1.task_execution_event_set_as_of(
      'wrf_69000000000000000000000000000011',
      current_boundary
    )
  ) THEN
    RAISE EXCEPTION 'task event set leaked across data scopes';
  END IF;
  SELECT * INTO STRICT scope_b_result
  FROM gowm_history_v1.task_execution_event_set_as_of(
    'wrf_69000000000000000000000000000012',
    current_boundary
  );
  IF scope_b_result.event_count IS DISTINCT FROM 1::bigint
     OR scope_b_result.max_world_version IS DISTINCT FROM 6991::bigint THEN
    RAISE EXCEPTION 'selected scope did not expose its own task event set';
  END IF;
END
$event_set_contract$;

SELECT set_config('gowm.data_scope_key', '', true);
SET LOCAL ROLE gowm_history_reader;

DO $reader_contract$
DECLARE
  reader_result record;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gowm_history_v1.task_execution_event_set_as_of(
      'wrf_69000000000000000000000000000011',
      '2026-08-31T03:00:00Z'
    )
  ) THEN
    RAISE EXCEPTION 'history reader bypassed explicit scope selection';
  END IF;

  PERFORM gowm_history_v1.set_data_scope('history-event-set-a');
  SELECT * INTO STRICT reader_result
  FROM gowm_history_v1.task_execution_event_set_as_of(
    'wrf_69000000000000000000000000000011',
    '2026-08-31T03:00:00Z'
  );
  IF reader_result.event_count IS DISTINCT FROM 2::bigint
     OR reader_result.max_world_version IS DISTINCT FROM 6902::bigint THEN
    RAISE EXCEPTION 'history reader did not receive the scoped current event set';
  END IF;

  BEGIN
    PERFORM count(*) FROM public.operational_task_event;
    RAISE EXCEPTION 'history reader accessed the operational event base table';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$reader_contract$;

RESET ROLE;
ROLLBACK;

SELECT 'TASK_EXECUTION_EVENT_SET_READ_CONTRACT_ASSERTIONS_PASS' AS result;
