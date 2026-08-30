\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.data_scope(scope_key, operational_domain, description) VALUES
  ('history-interval-a', 'TEST', 'Task interval assertion scope A'),
  ('history-interval-b', 'TEST', 'Task interval assertion scope B');

INSERT INTO public.world_reference_identity(
  reference_key, entity_kind, internal_id, data_scope_key
) VALUES (
  'wrf_48000000000000000000000000000001',
  'OPERATIONAL_TASK',
  'history-interval-task-a',
  'history-interval-a'
);

INSERT INTO public.operational_task(
  data_scope_key, operational_task_id, reference_key
) VALUES (
  'history-interval-a',
  'history-interval-task-a',
  'wrf_48000000000000000000000000000001'
);

INSERT INTO public.operational_task_event(
  data_scope_key, event_id, operational_task_id, event_type, event_time,
  received_time, subject_reference_key, actor_reference_keys,
  target_reference_keys, payload, confidence, provenance, world_version,
  source_authority, source_event_key, source_revision_no,
  arrival_classification, projection_disposition, content_hash
) VALUES
  (
    'history-interval-a', 'history-event-start', 'history-interval-task-a',
    'EXECUTION_STARTED_OBSERVED', '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:01Z', NULL, '[]', '[]', '{}', 1,
    '[{"authority":"history-assertion"}]', 4801,
    'history-assertion', 'history-start', 1, 'CURRENT', 'PENDING',
    'sha256:1111111111111111111111111111111111111111111111111111111111111111'
  ),
  (
    'history-interval-a', 'history-event-resume', 'history-interval-task-a',
    'EXECUTION_RESUMED_OBSERVED', '2026-01-01T00:00:02Z',
    '2026-01-01T00:00:03Z', NULL, '[]', '[]', '{}', 1,
    '[{"authority":"history-assertion"}]', 4802,
    'history-assertion', 'history-resume', 1, 'CURRENT', 'PENDING',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  ),
  (
    'history-interval-a', 'history-event-stop', 'history-interval-task-a',
    'EXECUTION_STOPPED_OBSERVED', '2026-01-01T00:00:05Z',
    '2026-01-01T00:00:06Z', NULL, '[]', '[]', '{}', 1,
    '[{"authority":"history-assertion"}]', 4803,
    'history-assertion', 'history-stop', 1, 'CURRENT', 'PENDING',
    'sha256:3333333333333333333333333333333333333333333333333333333333333333'
  );

CREATE TEMP TABLE interval_assertion_state(
  first_revision uuid,
  second_revision uuid,
  first_captured_at timestamptz,
  queue_id uuid,
  queue_generation bigint
);

DO $register_first$
DECLARE
  profile_hash text;
  input_rows jsonb;
  input_hash text;
  revision_id uuid;
  replay_id uuid;
BEGIN
  SELECT content_hash INTO STRICT profile_hash
  FROM gowm_history.method_profile
  WHERE profile_key = 'task-interval-observed-v1' AND profile_version = '1.0';

  input_rows := jsonb_build_array(
    jsonb_build_object(
      'eventNo', 1, 'eventId', 'history-event-start',
      'eventContentHash', 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      'inputRole', 'START_BOUNDARY'
    ),
    jsonb_build_object(
      'eventNo', 2, 'eventId', 'history-event-resume',
      'eventContentHash', 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      'inputRole', 'CONFLICT'
    ),
    jsonb_build_object(
      'eventNo', 3, 'eventId', 'history-event-stop',
      'eventContentHash', 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
      'inputRole', 'TERMINAL_BOUNDARY'
    )
  );
  SELECT public.grounding_sha256(jsonb_agg(jsonb_build_array(
    event.event_time,event.received_time,event.source_authority,
    event.source_event_key,event.source_revision_no,event.event_id,event.content_hash
  ) ORDER BY event.event_time,event.received_time,event.source_authority,
    event.source_event_key,event.source_revision_no,event.event_id)::text)
  INTO input_hash
  FROM public.operational_task_event event
  WHERE event.data_scope_key='history-interval-a'
    AND event.operational_task_id='history-interval-task-a';

  revision_id := gowm_history.register_task_execution_interval_revision(
    'history-interval-a', 'history-interval-task-a', 1,
    tstzrange('2026-01-01T00:00:00Z', '2026-01-01T00:00:05Z', '[)'),
    'CLOSED', 'OBSERVED_ONLY', 'PROVISIONAL',
    'history-event-start', 'history-event-stop', input_hash,
    'task-interval-observed-v1', '1.0', profile_hash, 0.75,
    ARRAY['DUPLICATE_RESUME'],
    'sha256:4444444444444444444444444444444444444444444444444444444444444444',
    NULL,
    jsonb_build_array(jsonb_build_object(
      'phaseNo', 1, 'phaseKind', 'RUNNING',
      'phaseRange', '["2026-01-01 00:00:00+00","2026-01-01 00:00:05+00")',
      'startEventId', 'history-event-start', 'endEventId', 'history-event-stop',
      'confidence', 0.75, 'reasonCodes', jsonb_build_array('DUPLICATE_RESUME')
    )),
    input_rows
  );

  replay_id := gowm_history.register_task_execution_interval_revision(
    'history-interval-a', 'history-interval-task-a', 1,
    tstzrange('2026-01-01T00:00:00Z', '2026-01-01T00:00:05Z', '[)'),
    'CLOSED', 'OBSERVED_ONLY', 'PROVISIONAL',
    'history-event-start', 'history-event-stop', input_hash,
    'task-interval-observed-v1', '1.0', profile_hash, 0.75,
    ARRAY['DUPLICATE_RESUME'],
    'sha256:4444444444444444444444444444444444444444444444444444444444444444',
    NULL, '[]'::jsonb, input_rows
  );

  IF revision_id IS DISTINCT FROM replay_id THEN
    RAISE EXCEPTION 'identical task interval content did not reuse its revision';
  END IF;

  INSERT INTO interval_assertion_state(first_revision, first_captured_at)
  VALUES (revision_id, clock_timestamp());
END
$register_first$;

SELECT pg_sleep(0.01);

INSERT INTO public.operational_task_event(
  data_scope_key, event_id, operational_task_id, event_type, event_time,
  received_time, subject_reference_key, actor_reference_keys,
  target_reference_keys, payload, confidence, provenance, world_version,
  source_authority, source_event_key, source_revision_no,
  arrival_classification, projection_disposition, content_hash
) VALUES (
  'history-interval-a', 'history-event-late-progress', 'history-interval-task-a',
  'EXECUTION_PROGRESS_OBSERVED', '2026-01-01T00:00:04Z',
  '2026-01-02T00:00:00Z', NULL, '[]', '[]', '{}', 0.8,
  '[{"authority":"history-assertion"}]', 4804,
  'history-assertion', 'history-late-progress', 1, 'LATE', 'PENDING_LATE_REPLAY',
  'sha256:5555555555555555555555555555555555555555555555555555555555555555'
);

DO $register_late_revision$
DECLARE
  profile_hash text;
  input_rows jsonb;
  input_hash text;
  prior_id uuid;
  revision_id uuid;
BEGIN
  SELECT content_hash INTO STRICT profile_hash
  FROM gowm_history.method_profile
  WHERE profile_key = 'task-interval-observed-v1' AND profile_version = '1.0';
  SELECT first_revision INTO STRICT prior_id FROM interval_assertion_state;

  input_rows := jsonb_build_array(
    jsonb_build_object('eventNo',1,'eventId','history-event-start','eventContentHash','sha256:1111111111111111111111111111111111111111111111111111111111111111','inputRole','START_BOUNDARY'),
    jsonb_build_object('eventNo',2,'eventId','history-event-resume','eventContentHash','sha256:2222222222222222222222222222222222222222222222222222222222222222','inputRole','CONFLICT'),
    jsonb_build_object('eventNo',3,'eventId','history-event-late-progress','eventContentHash','sha256:5555555555555555555555555555555555555555555555555555555555555555','inputRole','PROGRESS'),
    jsonb_build_object('eventNo',4,'eventId','history-event-stop','eventContentHash','sha256:3333333333333333333333333333333333333333333333333333333333333333','inputRole','TERMINAL_BOUNDARY')
  );
  SELECT public.grounding_sha256(jsonb_agg(jsonb_build_array(
    event.event_time,event.received_time,event.source_authority,
    event.source_event_key,event.source_revision_no,event.event_id,event.content_hash
  ) ORDER BY event.event_time,event.received_time,event.source_authority,
    event.source_event_key,event.source_revision_no,event.event_id)::text)
  INTO input_hash
  FROM public.operational_task_event event
  WHERE event.data_scope_key='history-interval-a'
    AND event.operational_task_id='history-interval-task-a';

  revision_id := gowm_history.register_task_execution_interval_revision(
    'history-interval-a', 'history-interval-task-a', 1,
    tstzrange('2026-01-01T00:00:00Z', '2026-01-01T00:00:05Z', '[)'),
    'CLOSED', 'OBSERVED_ONLY', 'PROVISIONAL',
    'history-event-start', 'history-event-stop', input_hash,
    'task-interval-observed-v1', '1.0', profile_hash, 0.75,
    ARRAY['DUPLICATE_RESUME','LATE_EVENT_REPLAY'],
    'sha256:6666666666666666666666666666666666666666666666666666666666666666',
    prior_id,
    jsonb_build_array(jsonb_build_object(
      'phaseNo',1,'phaseKind','RUNNING',
      'phaseRange','["2026-01-01 00:00:00+00","2026-01-01 00:00:05+00")',
      'startEventId','history-event-start','endEventId','history-event-stop',
      'confidence',0.75,'reasonCodes',jsonb_build_array('DUPLICATE_RESUME','LATE_EVENT_REPLAY')
    )),
    input_rows
  );
  UPDATE interval_assertion_state SET second_revision = revision_id;

  IF revision_id = prior_id OR
     (SELECT count(*)
      FROM gowm_history.task_execution_interval_revision revision
      JOIN gowm_history.task_execution_interval interval USING (interval_id)
      WHERE interval.data_scope_key = 'history-interval-a'
        AND interval.operational_task_id = 'history-interval-task-a'
        AND interval.execution_no = 1) <> 2 OR
     (SELECT supersedes_revision_id FROM gowm_history.task_execution_interval_revision
      WHERE interval_revision_id = revision_id) IS DISTINCT FROM prior_id THEN
    RAISE EXCEPTION 'late task event did not append a superseding revision';
  END IF;
END
$register_late_revision$;

DO $as_of_and_immutability$
DECLARE
  capture_time timestamptz;
  task_reference text := 'wrf_48000000000000000000000000000001';
  interval_reference text;
  old_revision uuid;
BEGIN
  SELECT first_captured_at, first_revision
  INTO STRICT capture_time, old_revision
  FROM interval_assertion_state;
  SELECT interval.reference_key INTO STRICT interval_reference
  FROM gowm_history.task_execution_interval interval
  WHERE interval.task_reference_key = task_reference;
  PERFORM set_config('gowm.data_scope_key', 'history-interval-a', true);
  IF (SELECT interval_revision_id
      FROM gowm_history_v1.task_execution_intervals_as_of(task_reference, capture_time))
      IS DISTINCT FROM old_revision THEN
    RAISE EXCEPTION 'task interval as-of lookup floated to a later revision';
  END IF;
  IF (SELECT interval_revision_id
      FROM gowm_history_v1.task_execution_interval_revision_by_reference_as_of(
        interval_reference,
        1,
        clock_timestamp()
      )) IS DISTINCT FROM old_revision THEN
    RAISE EXCEPTION 'exact task interval reference pin was not replayable';
  END IF;

  BEGIN
    UPDATE gowm_history.task_execution_interval_revision
    SET confidence = 1
    WHERE interval_revision_id = old_revision;
    RAISE EXCEPTION 'task interval revision was mutable';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
END
$as_of_and_immutability$;

SELECT set_config('gowm.data_scope_key', '', true);
SET LOCAL ROLE gowm_history_reader;

DO $scope_before_read$
BEGIN
  IF EXISTS (SELECT 1 FROM gowm_history_v1.task_execution_interval_effective) THEN
    RAISE EXCEPTION 'task interval was visible before scope selection';
  END IF;
  BEGIN
    PERFORM count(*) FROM gowm_history.task_execution_interval_revision;
    RAISE EXCEPTION 'history reader accessed task interval base tables';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$scope_before_read$;

SELECT gowm_history_v1.set_data_scope('history-interval-a');

DO $scoped_read$
BEGIN
  IF (SELECT count(*) FROM gowm_history_v1.task_execution_interval_effective) <> 1
     OR (SELECT revision_no FROM gowm_history_v1.task_execution_interval_effective) <> 2
     OR (SELECT count(*) FROM gowm_history_v1.task_execution_phase) <> 2 THEN
    RAISE EXCEPTION 'scope-selected task interval read contract is incomplete';
  END IF;
END
$scoped_read$;

RESET ROLE;

DO $queue_and_grants$
DECLARE
  initial_claim gowm_history.task_interval_projection_queue%ROWTYPE;
  crashed_claim gowm_history.task_interval_projection_queue%ROWTYPE;
  candidate gowm_history.task_interval_projection_queue%ROWTYPE;
  reclaimed_claim gowm_history.task_interval_projection_queue%ROWTYPE;
  other_claim gowm_history.task_interval_projection_queue%ROWTYPE;
  restart_error constant text := 'task interval restart diagnostic';
BEGIN
  SELECT * INTO STRICT initial_claim
  FROM gowm_history.claim_task_interval_projection(
    'history-worker-first', 1, interval '30 seconds'
  );
  IF NOT gowm_history.fail_task_interval_projection(
       initial_claim.queue_id,
       'history-worker-first',
       initial_claim.generation,
       restart_error,
       clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'task interval worker could not persist its pre-restart error';
  END IF;

  SELECT * INTO STRICT crashed_claim
  FROM gowm_history.claim_task_interval_projection(
    'history-worker-crashed', 1, interval '30 seconds'
  );
  IF crashed_claim.queue_id IS DISTINCT FROM initial_claim.queue_id
     OR crashed_claim.generation <> initial_claim.generation + 1
     OR crashed_claim.last_error IS DISTINCT FROM restart_error THEN
    RAISE EXCEPTION 'task interval retry did not preserve queue identity, generation, or last_error';
  END IF;

  UPDATE gowm_history.task_interval_projection_queue queue
  SET locked_at = clock_timestamp() - interval '2 seconds',
      lease_until = clock_timestamp() - interval '1 second'
  WHERE queue.queue_id = crashed_claim.queue_id;

  INSERT INTO public.world_reference_identity(
    reference_key, entity_kind, internal_id, data_scope_key
  ) VALUES (
    'wrf_48000000000000000000000000000002',
    'OPERATIONAL_TASK',
    'history-interval-task-b',
    'history-interval-a'
  );
  INSERT INTO public.operational_task(
    data_scope_key, operational_task_id, reference_key
  ) VALUES (
    'history-interval-a',
    'history-interval-task-b',
    'wrf_48000000000000000000000000000002'
  );
  INSERT INTO public.operational_task_event(
    data_scope_key, event_id, operational_task_id, event_type, event_time,
    received_time, subject_reference_key, actor_reference_keys,
    target_reference_keys, payload, confidence, provenance, world_version,
    source_authority, source_event_key, source_revision_no,
    arrival_classification, projection_disposition, content_hash
  ) VALUES (
    'history-interval-a', 'history-event-other-task', 'history-interval-task-b',
    'EXECUTION_STARTED_OBSERVED', '2026-01-01T00:00:07Z',
    '2026-01-01T00:00:08Z', NULL, '[]', '[]', '{}', 1,
    '[{"authority":"history-assertion"}]', 4805,
    'history-assertion', 'history-other-task', 1, 'CURRENT', 'PENDING',
    'sha256:7777777777777777777777777777777777777777777777777777777777777777'
  );

  FOR candidate IN
    SELECT *
    FROM gowm_history.claim_task_interval_projection(
      'history-worker-restarted', 2, interval '30 seconds'
    )
  LOOP
    IF candidate.queue_id = crashed_claim.queue_id THEN
      reclaimed_claim := candidate;
    ELSIF candidate.operational_task_id = 'history-interval-task-b' THEN
      other_claim := candidate;
    END IF;
  END LOOP;

  IF reclaimed_claim.queue_id IS NULL
     OR reclaimed_claim.generation <> crashed_claim.generation + 1
     OR reclaimed_claim.last_error IS DISTINCT FROM restart_error THEN
    RAISE EXCEPTION 'expired task interval Lease was not reclaimed with its last_error intact';
  END IF;
  IF other_claim.queue_id IS NULL THEN
    RAISE EXCEPTION 'expired task interval reclaim blocked another Task Key';
  END IF;

  IF gowm_history.complete_task_interval_projection(
       reclaimed_claim.queue_id,
       'history-worker-restarted',
       crashed_claim.generation
     ) THEN
    RAISE EXCEPTION 'stale task interval worker generation completed a queue item';
  END IF;
  IF NOT gowm_history.complete_task_interval_projection(
       reclaimed_claim.queue_id,
       'history-worker-restarted',
       reclaimed_claim.generation
     ) THEN
    RAISE EXCEPTION 'current task interval worker could not complete a queue item';
  END IF;
  IF NOT gowm_history.complete_task_interval_projection(
       other_claim.queue_id,
       'history-worker-restarted',
       other_claim.generation
     ) THEN
    RAISE EXCEPTION 'task interval restart could not complete the independent Task Key';
  END IF;
  IF (SELECT count(*)
      FROM gowm_history.task_execution_interval_revision revision
      JOIN gowm_history.task_execution_interval interval USING (interval_id)
      WHERE interval.data_scope_key = 'history-interval-a'
        AND interval.operational_task_id = 'history-interval-task-a'
        AND interval.execution_no = 1) <> 2
     OR EXISTS (
       SELECT revision.content_hash
       FROM gowm_history.task_execution_interval_revision revision
       JOIN gowm_history.task_execution_interval interval USING (interval_id)
       WHERE interval.data_scope_key = 'history-interval-a'
         AND interval.operational_task_id = 'history-interval-task-a'
         AND interval.execution_no = 1
       GROUP BY revision.content_hash
       HAVING count(*) > 1
     ) THEN
    RAISE EXCEPTION 'task interval restart duplicated an existing content Revision';
  END IF;
  IF NOT pg_has_role('gowm_operational_service', 'gowm_history_reader', 'member') THEN
    RAISE EXCEPTION 'operational provider did not inherit scoped history reader';
  END IF;
END
$queue_and_grants$;

SET LOCAL ROLE gowm_history_writer;
DO $controlled_head$
BEGIN
  BEGIN
    UPDATE gowm_history.task_execution_interval_head
    SET updated_at = clock_timestamp();
    RAISE EXCEPTION 'history writer received direct task interval head mutation';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$controlled_head$;
RESET ROLE;

ROLLBACK;
SELECT 'TASK_EXECUTION_INTERVAL_ASSERTIONS_PASS' AS result;
