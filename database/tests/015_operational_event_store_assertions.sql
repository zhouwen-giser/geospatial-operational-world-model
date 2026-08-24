\set ON_ERROR_STOP on

BEGIN;

INSERT INTO data_scope(scope_key,operational_domain,description) VALUES
  ('operational-event-a','TEST','Operational event scope A'),
  ('operational-event-b','TEST','Operational event scope B');

SELECT * FROM ingest_operational_task_event(
  'operational-event-a','provider-a','source-event-1',1,'operational-event-1','ot_internal_1',
  'EXECUTION_PROGRESS_OBSERVED','2026-08-24T01:00:00Z','2026-08-24T01:00:01Z',NULL,
  '[{"namespace":"gowm","kind":"WORLD_OBJECT","id":"wrf_11111111111111111111111111111111","version":"1"}]',
  '[{"namespace":"gowm","kind":"WORLD_OBJECT","id":"wrf_22222222222222222222222222222222","version":"1"}]',
  NULL,'{"progress":0.5}',0.9,
  '[{"evidenceId":"provider-record-1","authority":"provider-a","evidenceType":"PROVIDER_EVENT","observedAt":"2026-08-24T01:00:00Z"}]',
  '[{"claimId":"claim-provider-action-1","externalAuthority":"provider-a","externalKind":"PROVIDER_ACTION","externalValue":"provider-action-1","relationHint":"RELATED_TO","matchBasis":"PROVIDER_DECLARED","confidence":1,"observedAt":"2026-08-24T01:00:00Z","receivedAt":"2026-08-24T01:00:01Z","evidenceIds":["provider-record-1"]}]',
  300000,86400000
);

DO $stable_retry$
DECLARE
  outcome record;
BEGIN
  SELECT * INTO STRICT outcome FROM ingest_operational_task_event(
    'operational-event-a','provider-a','source-event-1',1,'operational-event-1','ot_internal_1',
    'EXECUTION_PROGRESS_OBSERVED','2026-08-24T01:00:00Z','2026-08-24T01:05:00Z',NULL,
    '[{"namespace":"gowm","kind":"WORLD_OBJECT","id":"wrf_11111111111111111111111111111111","version":"1"}]',
    '[{"namespace":"gowm","kind":"WORLD_OBJECT","id":"wrf_22222222222222222222222222222222","version":"1"}]',
    NULL,'{"progress":0.5}',0.9,
    '[{"evidenceId":"provider-record-1","authority":"provider-a","evidenceType":"PROVIDER_EVENT","observedAt":"2026-08-24T01:00:00Z"}]',
    '[{"claimId":"claim-provider-action-1","externalAuthority":"provider-a","externalKind":"PROVIDER_ACTION","externalValue":"provider-action-1","relationHint":"RELATED_TO","matchBasis":"PROVIDER_DECLARED","confidence":1,"observedAt":"2026-08-24T01:00:00Z","receivedAt":"2026-08-24T01:00:01Z","evidenceIds":["provider-record-1"]}]',
    300000,86400000
  );
  IF outcome.ingest_status<>'DUPLICATE' OR outcome.stored_arrival_classification<>'CURRENT' THEN
    RAISE EXCEPTION 'stable retry did not resolve the original event';
  END IF;
  IF (SELECT count(*) FROM operational_task_event WHERE data_scope_key='operational-event-a' AND event_id='operational-event-1')<>1 OR
     (SELECT count(*) FROM operational_event_outbox WHERE data_scope_key='operational-event-a' AND event_id='operational-event-1')<>1 THEN
    RAISE EXCEPTION 'retry duplicated event or outbox';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM external_correlation_claim
    WHERE data_scope_key='operational-event-a' AND source_kind='OPERATIONAL_EVENT'
      AND source_id='operational-event-1' AND external_kind='PROVIDER_ACTION'
      AND external_value='provider-action-1' AND match_basis='PROVIDER_DECLARED'
  ) THEN
    RAISE EXCEPTION 'operational event correlation claim was not materialized';
  END IF;
END
$stable_retry$;

DO $conflict_policy$
BEGIN
  BEGIN
    PERFORM ingest_operational_task_event(
      'operational-event-a','provider-a','source-event-1',1,'operational-event-1','ot_internal_1',
      'EXECUTION_PROGRESS_OBSERVED','2026-08-24T01:00:00Z','2026-08-24T01:00:02Z',NULL,
      '[]','[]',NULL,'{"progress":0.75}',0.9,
      '[{"evidenceId":"provider-record-1","authority":"provider-a","evidenceType":"PROVIDER_EVENT"}]','[]',
      300000,86400000
    );
    RAISE EXCEPTION 'changed event payload reused a stable event id';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    PERFORM ingest_operational_task_event(
      'operational-event-a','provider-a','source-event-1',1,'operational-event-changed-id','ot_internal_1',
      'EXECUTION_PROGRESS_OBSERVED','2026-08-24T01:00:00Z','2026-08-24T01:00:02Z',NULL,
      '[]','[]',NULL,'{"progress":0.5}',0.9,
      '[{"evidenceId":"provider-record-1","authority":"provider-a","evidenceType":"PROVIDER_EVENT"}]','[]',
      300000,86400000
    );
    RAISE EXCEPTION 'stable source revision accepted a changed event id';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    PERFORM ingest_operational_task_event(
      'operational-event-a','provider-a','source-event-future',1,'operational-event-future','ot_internal_1',
      'EXECUTION_STARTED_OBSERVED','2026-08-24T02:00:00Z','2026-08-24T01:00:00Z',NULL,
      '[]','[]',NULL,'{}',1,
      '[{"evidenceId":"provider-record-future","authority":"provider-a","evidenceType":"PROVIDER_EVENT"}]','[]',
      300000,86400000
    );
    RAISE EXCEPTION 'future event bypassed skew policy';
  EXCEPTION WHEN SQLSTATE '22007' THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM operational_task_event WHERE event_id='operational-event-future') THEN
    RAISE EXCEPTION 'rejected future event was retained';
  END IF;
END
$conflict_policy$;

SELECT * FROM ingest_operational_task_event(
  'operational-event-a','provider-a','source-event-late',1,'operational-event-late','ot_internal_1',
  'EXECUTION_STARTED_OBSERVED','2026-08-20T01:00:00Z','2026-08-24T01:00:00Z',NULL,
  '[]','[]',NULL,'{}',0.8,
  '[{"evidenceId":"provider-record-late","authority":"provider-a","evidenceType":"PROVIDER_EVENT"}]','[]',
  300000,86400000
);

SELECT * FROM ingest_operational_task_event(
  'operational-event-b','provider-a','source-event-1',1,'operational-event-1','ot_internal_scope_b',
  'EXECUTION_STARTED_OBSERVED','2026-08-24T01:00:00Z','2026-08-24T01:00:01Z',NULL,
  '[]','[]',NULL,'{}',0.8,
  '[{"evidenceId":"provider-record-scope-b","authority":"provider-a","evidenceType":"PROVIDER_EVENT"}]','[]',
  300000,86400000
);

DO $late_scope_outbox_atomicity$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM operational_task_event
    WHERE data_scope_key='operational-event-a' AND event_id='operational-event-late'
      AND arrival_classification='LATE' AND projection_disposition='PENDING_LATE_REPLAY'
      AND event_time='2026-08-20T01:00:00Z' AND received_time='2026-08-24T01:00:00Z'
  ) THEN
    RAISE EXCEPTION 'late event was not retained with separated event and receipt times';
  END IF;
  IF (SELECT count(*) FROM operational_task_event WHERE event_id='operational-event-1')<>2 OR
     (SELECT count(*) FROM operational_task_event WHERE data_scope_key='operational-event-b' AND event_id='operational-event-1')<>1 THEN
    RAISE EXCEPTION 'scope-local event identity was not isolated';
  END IF;
  BEGIN
    PERFORM ingest_operational_task_event(
      'operational-event-a','provider-a','source-event-fault',1,'operational-event-fault','ot_internal_1',
      'EXECUTION_PAUSED_OBSERVED','2026-08-24T01:00:00Z','2026-08-24T01:00:01Z',NULL,
      '[]','[]',NULL,'{}',1,
      '[{"evidenceId":"provider-record-fault","authority":"provider-a","evidenceType":"PROVIDER_EVENT"}]','[]',
      300000,86400000
    );
    RAISE EXCEPTION 'injected failure';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM operational_task_event WHERE event_id='operational-event-fault') OR
     EXISTS (SELECT 1 FROM operational_event_outbox WHERE event_id='operational-event-fault') THEN
    RAISE EXCEPTION 'fault left a ghost event or outbox row';
  END IF;
  BEGIN
    UPDATE operational_task_event SET payload='{}' WHERE data_scope_key='operational-event-a' AND event_id='operational-event-1';
    RAISE EXCEPTION 'operational event was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    DELETE FROM operational_task_event WHERE data_scope_key='operational-event-a' AND event_id='operational-event-1';
    RAISE EXCEPTION 'operational event was deletable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  UPDATE operational_event_outbox SET attempts=attempts+1,last_error='publish unavailable'
  WHERE data_scope_key='operational-event-a' AND event_id='operational-event-1';
  BEGIN
    UPDATE operational_event_outbox SET event_payload='{}'
    WHERE data_scope_key='operational-event-a' AND event_id='operational-event-1';
    RAISE EXCEPTION 'outbox payload was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$late_scope_outbox_atomicity$;

ROLLBACK;

SELECT 'OPERATIONAL_EVENT_STORE_ASSERTIONS_PASS' AS result;
