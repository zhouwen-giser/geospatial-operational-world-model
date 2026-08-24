\set ON_ERROR_STOP on

BEGIN;

INSERT INTO data_scope(scope_key,operational_domain,description) VALUES
  ('operational-projection-a','TEST','Operational projection scope A'),
  ('operational-projection-b','TEST','Operational projection scope B');

CREATE FUNCTION pg_temp.add_operational_event(
  p_scope text,p_task text,p_event_id text,p_event_type text,p_event_time timestamptz,
  p_received_time timestamptz,p_authority text DEFAULT 'provider-a',
  p_confidence double precision DEFAULT 0.8,p_payload jsonb DEFAULT '{}'::jsonb,
  p_claims jsonb DEFAULT '[]'::jsonb
)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM ingest_operational_task_event(
    p_scope,p_authority,p_event_id,1,p_event_id,p_task,p_event_type,p_event_time,p_received_time,
    NULL,'[]','[]',NULL,p_payload,p_confidence,
    jsonb_build_array(jsonb_build_object(
      'evidenceId','evidence-' || p_event_id,'authority',p_authority,'evidenceType','OPERATIONAL_TEST',
      'observedAt',p_event_time
    )),p_claims,300000,86400000
  );
END
$fn$;

SELECT pg_temp.add_operational_event(
  'operational-projection-a','ot-main','main-request','CONTROL_REQUEST_OBSERVED',
  '2026-08-24T01:00:00Z','2026-08-24T01:00:01Z','provider-a',0.8,
  '{"taskType":"INSPECTION"}',
  '[{"claimId":"main-planning-claim","externalAuthority":"planner-a","externalKind":"PLANNING_TASK","externalValue":"planning-task-main","relationHint":"REPORTS_EXECUTION_OF","matchBasis":"PROPAGATED_CORRELATION_ID","confidence":1,"observedAt":"2026-08-24T01:00:00Z","receivedAt":"2026-08-24T01:00:01Z","evidenceIds":["evidence-main-request"]}]'
);
SELECT pg_temp.add_operational_event('operational-projection-a','ot-main','main-accepted','CONTROL_ACCEPTED_OBSERVED','2026-08-24T01:01:00Z','2026-08-24T01:01:01Z');
SELECT pg_temp.add_operational_event('operational-projection-a','ot-main','main-started','EXECUTION_STARTED_OBSERVED','2026-08-24T01:02:00Z','2026-08-24T01:02:01Z');
SELECT pg_temp.add_operational_event('operational-projection-a','ot-main','main-progress','EXECUTION_PROGRESS_OBSERVED','2026-08-24T01:03:00Z','2026-08-24T01:03:01Z');
SELECT pg_temp.add_operational_event('operational-projection-a','ot-main','main-completed','CONTROL_COMPLETED_REPORTED','2026-08-24T01:04:00Z','2026-08-24T01:04:01Z');
SELECT project_operational_task('operational-projection-a','ot-main');

CREATE TEMP TABLE projection_versions(stage text PRIMARY KEY,world_version bigint NOT NULL,snapshot_hash text NOT NULL);
INSERT INTO projection_versions
SELECT 'completed',world_version,snapshot_hash FROM operational_task_snapshot
WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-main';

DO $completed_unverified$
DECLARE snapshot record;
BEGIN
  SELECT * INTO STRICT snapshot FROM operational_task_snapshot
  WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-main';
  IF snapshot.task_type<>'INSPECTION' OR snapshot.control_state<>'COMPLETED_REPORTED' OR
     snapshot.activity_state<>'ACTIVE_OBSERVED' OR snapshot.outcome_verification<>'UNVERIFIED' OR
     snapshot.observability<>'FRESH' OR jsonb_array_length(snapshot.evidence_ids)<>5 OR
     snapshot.correlation_claim_summary->>'PLANNING_TASK'<>'1' THEN
    RAISE EXCEPTION 'completed report collapsed or omitted an independent projection dimension';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM world_reference_identity
    WHERE reference_key=snapshot.reference_key AND entity_kind='OPERATIONAL_TASK'
      AND internal_id='ot-main' AND internal_id<>'planning-task-main'
  ) THEN
    RAISE EXCEPTION 'operational task identity was not internal and opaque';
  END IF;
END
$completed_unverified$;

SELECT pg_temp.add_operational_event('operational-projection-a','ot-main','main-confirmed','PHYSICAL_EFFECT_CONFIRMED','2026-08-24T01:05:00Z','2026-08-24T01:05:01Z','physical-sensor',0.95);
SELECT project_operational_task('operational-projection-a','ot-main');
INSERT INTO projection_versions SELECT 'verified',world_version,snapshot_hash FROM operational_task_snapshot
WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-main';

SELECT pg_temp.add_operational_event('operational-projection-a','ot-main','main-contradicted','PHYSICAL_EFFECT_CONTRADICTED','2026-08-24T01:06:00Z','2026-08-24T01:06:01Z','physical-sensor',0.99);
SELECT pg_temp.add_operational_event('operational-projection-a','ot-main','main-gap-open','OBSERVATION_GAP_OPENED','2026-08-24T01:07:00Z','2026-08-24T01:07:01Z','physical-sensor',1);
SELECT project_operational_task('operational-projection-a','ot-main');
INSERT INTO projection_versions SELECT 'contradicted-gap',world_version,snapshot_hash FROM operational_task_snapshot
WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-main';

SELECT pg_temp.add_operational_event('operational-projection-a','ot-main','main-late-stop','EXECUTION_STOPPED_OBSERVED','2026-08-24T01:02:30Z','2026-08-30T01:00:00Z');
SELECT project_operational_task('operational-projection-a','ot-main','operational-projection-v1','LATE_REPLAY');
INSERT INTO projection_versions SELECT 'late-replay',world_version,snapshot_hash FROM operational_task_snapshot
WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-main';

DO $independent_dimensions_and_late$
DECLARE snapshot record;
BEGIN
  SELECT * INTO STRICT snapshot FROM operational_task_snapshot
  WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-main';
  IF snapshot.control_state<>'COMPLETED_REPORTED' OR snapshot.activity_state<>'ACTIVE_OBSERVED' OR
     snapshot.outcome_verification<>'CONTRADICTED' OR snapshot.observability<>'OBSERVATION_GAP' THEN
    RAISE EXCEPTION 'physical contradiction, gap, or late event corrupted independent current dimensions';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operational_task_event
    WHERE data_scope_key='operational-projection-a' AND event_id='main-late-stop'
      AND arrival_classification='LATE'
  ) THEN
    RAISE EXCEPTION 'late source event was not retained in history';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT world_version,lag(world_version) OVER (ORDER BY world_version) AS prior
      FROM projection_versions
    ) versions WHERE prior IS NOT NULL AND world_version<=prior
  ) OR (SELECT count(DISTINCT world_version) FROM projection_versions)<>4 THEN
    RAISE EXCEPTION 'projection changes did not advance worldVersion monotonically';
  END IF;
END
$independent_dimensions_and_late$;

SELECT pg_temp.add_operational_event('operational-projection-a','ot-tie','tie-a','EXECUTION_PAUSED_OBSERVED','2026-08-24T02:00:00Z','2026-08-24T02:00:01Z','provider-a',0.8);
SELECT pg_temp.add_operational_event('operational-projection-a','ot-tie','tie-z','EXECUTION_STOPPED_OBSERVED','2026-08-24T02:00:00Z','2026-08-24T02:00:02Z','provider-a',0.8);
SELECT project_operational_task('operational-projection-a','ot-tie');

SELECT pg_temp.add_operational_event('operational-projection-a','ot-priority','priority-z','EXECUTION_STOPPED_OBSERVED','2026-08-24T03:00:00Z','2026-08-24T03:00:01Z','simulation',1);
SELECT pg_temp.add_operational_event('operational-projection-a','ot-priority','priority-a','EXECUTION_PAUSED_OBSERVED','2026-08-24T03:00:00Z','2026-08-24T03:00:02Z','manual',0.1);
SELECT project_operational_task('operational-projection-a','ot-priority');

DO $stable_order_replay_atomicity$
DECLARE
  before_version bigint;
  before_hash text;
BEGIN
  IF (SELECT activity_state FROM operational_task_snapshot
      WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-tie')<>'STOPPED_OBSERVED' THEN
    RAISE EXCEPTION 'event id did not provide the stable final tie break';
  END IF;
  IF (SELECT activity_state FROM operational_task_snapshot
      WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-priority')<>'PAUSED_OBSERVED' THEN
    RAISE EXCEPTION 'source priority did not outrank confidence and event id';
  END IF;
  IF operational_snapshot_current_hash('operational-projection-a')<>
     operational_snapshot_replay_hash('operational-projection-a') THEN
    RAISE EXCEPTION 'live projection hash differs from immutable event replay hash';
  END IF;
  SELECT world_version,snapshot_hash INTO STRICT before_version,before_hash
  FROM operational_task_snapshot
  WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-main';
  PERFORM rebuild_operational_task_snapshots('operational-projection-a');
  IF (SELECT world_version FROM operational_task_snapshot
      WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-main')<>before_version OR
     (SELECT snapshot_hash FROM operational_task_snapshot
      WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-main')<>before_hash THEN
    RAISE EXCEPTION 'no-change full replay mutated current projection';
  END IF;
  BEGIN
    UPDATE operational_task_snapshot SET activity_state='UNKNOWN'
    WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-main';
    RAISE EXCEPTION 'current snapshot accepted a direct write';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE operational_projection_audit SET snapshot='{}'
    WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-main';
    RAISE EXCEPTION 'projection audit was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$stable_order_replay_atomicity$;

SELECT pg_temp.add_operational_event('operational-projection-b','ot-main','scope-b-event','EXECUTION_STARTED_OBSERVED','2026-08-24T04:00:00Z','2026-08-24T04:00:01Z');

DO $projection_failure_is_atomic$
DECLARE main_hash text;
BEGIN
  SELECT snapshot_hash INTO STRICT main_hash FROM operational_task_snapshot
  WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-main';
  BEGIN
    PERFORM project_operational_task('operational-projection-b','ot-main');
    RAISE EXCEPTION 'cross-scope task identity projection unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM operational_task_event
    WHERE data_scope_key='operational-projection-b' AND event_id='scope-b-event'
  ) OR EXISTS (
    SELECT 1 FROM operational_task_snapshot
    WHERE data_scope_key='operational-projection-b' AND operational_task_id='ot-main'
  ) OR (SELECT snapshot_hash FROM operational_task_snapshot
        WHERE data_scope_key='operational-projection-a' AND operational_task_id='ot-main')<>main_hash THEN
    RAISE EXCEPTION 'projection failure lost source event or partially changed current state';
  END IF;
END
$projection_failure_is_atomic$;

ROLLBACK;

SELECT 'OPERATIONAL_PROJECTION_ASSERTIONS_PASS' AS result;
