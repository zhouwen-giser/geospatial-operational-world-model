ALTER TABLE ugv_smpp.provider_task 
  ADD COLUMN observation_revision bigint
    NOT NULL
    DEFAULT 0
    CHECK (observation_revision >= 0);

UPDATE ugv_smpp.provider_task AS task SET observation_revision = observed.revision FROM ( SELECT
  task_id,
  COALESCE(max(revision), 0) AS revision
FROM ugv_smpp.task_observation
GROUP BY
  task_id ) AS observed WHERE task.task_id = observed.task_id;

ALTER TABLE ugv_smpp.task_observation 
  ADD COLUMN message text,
  ADD COLUMN substate text,
  ADD COLUMN progress jsonb,
  ADD COLUMN source text,
  ADD COLUMN adapter_revision bigint
    CHECK (
      adapter_revision IS NULL
        OR adapter_revision >= 0
    );

UPDATE ugv_smpp.task_observation AS observation SET message = task.status_message,substate = task.substate,source = CASE 
  WHEN observation.type IN ('task.scheduled', 'task.start_window_missed', 'task.admission_rejected', 'task.cancel_rejected', 'task.start_window_violation') THEN 'runtime' 
  ELSE 'adapter' 
END,adapter_revision = CASE 
  WHEN observation.type IN ('task.scheduled', 'task.start_window_missed', 'task.admission_rejected', 'task.cancel_rejected', 'task.start_window_violation') THEN NULL 
  ELSE observation.revision 
END FROM ugv_smpp.provider_task AS task WHERE task.task_id = observation.task_id;

ALTER TABLE ugv_smpp.task_observation 
  ALTER COLUMN source SET NOT NULL,
  ADD CONSTRAINT task_observation_source_check 
    CHECK (source IN ('runtime', 'adapter'));

ALTER TABLE ugv_smpp.outbox_event 
  ADD COLUMN event_key text;

UPDATE ugv_smpp.outbox_event SET event_key = event_id::text WHERE event_key IS NULL;

ALTER TABLE ugv_smpp.outbox_event 
  ALTER COLUMN event_key SET NOT NULL,
  ADD CONSTRAINT outbox_event_event_key_unique 
    UNIQUE (event_key);

CREATE INDEX task_observation_adapter_revision_idx ON ugv_smpp.task_observation (task_id, adapter_revision) WHERE adapter_revision IS NOT NULL;
