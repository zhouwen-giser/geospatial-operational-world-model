\set ON_ERROR_STOP on

BEGIN;

INSERT INTO data_scope(scope_key,operational_domain,description) VALUES
  ('operational-read-a','TEST','Operational read scope A'),
  ('operational-read-b','TEST','Operational read scope B');

SELECT ingest_operational_task_event(
  'operational-read-a','provider-read','read-event-a',1,'read-event-a','ot-read-a',
  'CONTROL_COMPLETED_REPORTED','2026-08-24T06:00:00Z','2026-08-24T06:00:02Z',NULL,
  '[{"namespace":"gowm","kind":"WORLD_OBJECT","id":"wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","version":"1"}]',
  '[]',NULL,'{"taskType":"READ_TEST"}',0.8,
  '[{"evidenceId":"read-evidence-a","authority":"provider-read","evidenceType":"PROVIDER_EVENT"}]','[]',
  300000,86400000
);
SELECT ingest_operational_task_event(
  'operational-read-b','provider-read','read-event-b',1,'read-event-b','ot-read-b',
  'EXECUTION_STARTED_OBSERVED','2026-08-24T06:00:00Z','2026-08-24T06:00:01Z',NULL,
  '[]','[]',NULL,'{}',0.8,
  '[{"evidenceId":"read-evidence-b","authority":"provider-read","evidenceType":"PROVIDER_EVENT"}]','[]',
  300000,86400000
);
SELECT project_operational_task('operational-read-a','ot-read-a');
SELECT project_operational_task('operational-read-b','ot-read-b');

SET LOCAL ROLE gowm_operational_reader;
SELECT gowm_operational_reality_v1.set_data_scope('operational-read-a');

DO $read_scope_a$
DECLARE
  context record;
BEGIN
  IF (SELECT count(*) FROM gowm_operational_reality_v1.task_snapshot)<>1 OR
     (SELECT operational_task_id FROM gowm_operational_reality_v1.task_snapshot)<>'ot-read-a' OR
     (SELECT count(*) FROM gowm_operational_reality_v1.task_event)<>1 OR
     EXISTS (SELECT 1 FROM gowm_operational_reality_v1.task_snapshot WHERE operational_task_id='ot-read-b') THEN
    RAISE EXCEPTION 'operational read views leaked or omitted scoped rows';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM gowm_operational_reality_v1.task_event
    WHERE event_id='read-event-a' AND event_time='2026-08-24T06:00:00Z'
      AND received_time='2026-08-24T06:00:02Z'
  ) THEN RAISE EXCEPTION 'operational timeline lost event/receipt time separation'; END IF;
  SELECT * INTO STRICT context FROM gowm_operational_reality_v1.snapshot_context();
  IF context.world_version<=0 OR context.scope_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'operational read snapshot context is invalid';
  END IF;
  BEGIN
    PERFORM count(*) FROM public.operational_task_snapshot;
    RAISE EXCEPTION 'operational reader accessed a base table';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.project_pending_operational_tasks(1);
    RAISE EXCEPTION 'operational reader executed a Foundation write function';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$read_scope_a$;

SELECT gowm_operational_reality_v1.set_data_scope('operational-read-b');
DO $read_scope_b$
BEGIN
  IF (SELECT count(*) FROM gowm_operational_reality_v1.task_snapshot)<>1 OR
     (SELECT operational_task_id FROM gowm_operational_reality_v1.task_snapshot)<>'ot-read-b' OR
     EXISTS (SELECT 1 FROM gowm_operational_reality_v1.task_event WHERE event_id='read-event-a') THEN
    RAISE EXCEPTION 'changing authorized scope retained rows from the previous scope';
  END IF;
END
$read_scope_b$;

RESET ROLE;

ROLLBACK;

SELECT 'OPERATIONAL_READ_CONTRACT_ASSERTIONS_PASS' AS result;
