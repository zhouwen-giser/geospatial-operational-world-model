CREATE SCHEMA ugv_ingest;

CREATE TYPE ugv_ingest.processing_state AS ENUM (
  'RECEIVED','VALIDATED','MAPPED','OUTBOXED','DELIVERED','IGNORED_BY_POLICY','DEAD_LETTER'
);
CREATE TYPE ugv_ingest.destination_kind AS ENUM ('OBSERVATION','OPERATIONAL_EVENT');

-- The fixed airport simulation is explicitly EPSG:32648. Register its named
-- analysis space independently of GOWM's general-purpose default (32650).
INSERT INTO analysis_space(
  analysis_space_key,canonical_srid,dimension_model,distance_model,transform_pipeline_version
) VALUES ('airport-utm48n',32648,'2D','PLANAR_METRE_V1','ugv-airport-wgs84-to-utm48n-v1')
ON CONFLICT (analysis_space_key) DO NOTHING;

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM analysis_space
    WHERE analysis_space_key='airport-utm48n' AND canonical_srid=32648
      AND dimension_model='2D' AND distance_model='PLANAR_METRE_V1'
  ) THEN
    RAISE EXCEPTION 'airport-utm48n analysis space conflicts with the fixed EPSG:32648 UGV contract';
  END IF;
END
$guard$;

CREATE TABLE ugv_ingest.mqtt_session (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL,
  broker_id text NOT NULL,
  session_epoch bigint NOT NULL CHECK (session_epoch > 0),
  session_present boolean NOT NULL,
  protocol_version integer NOT NULL CHECK (protocol_version = 5),
  connected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disconnected_at timestamptz,
  disconnect_reason text,
  subscription_acks jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_schema_lock jsonb NOT NULL,
  mapper_context jsonb NOT NULL CHECK (jsonb_typeof(mapper_context)='object'),
  mapper_context_hash text NOT NULL CHECK (mapper_context_hash ~ '^[0-9a-f]{64}$'),
  code_version text NOT NULL,
  UNIQUE (client_id,broker_id,session_epoch)
);

CREATE TABLE ugv_ingest.inbox_message (
  message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingest_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  session_id uuid NOT NULL REFERENCES ugv_ingest.mqtt_session,
  device_id text NOT NULL,
  topic text NOT NULL,
  packet_id integer,
  packet_generation bigint NOT NULL DEFAULT 1 CHECK (packet_generation > 0),
  qos smallint NOT NULL CHECK (qos BETWEEN 0 AND 2),
  duplicate_flag boolean NOT NULL,
  retained_flag boolean NOT NULL,
  payload_size integer NOT NULL CHECK (payload_size >= 0),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  raw_payload bytea NOT NULL,
  decoded_payload jsonb,
  adapter_received_at timestamptz NOT NULL,
  schema_version text NOT NULL,
  schema_hash text NOT NULL CHECK (schema_hash ~ '^[0-9a-f]{64}$'),
  validation_state text NOT NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  redelivery_count integer NOT NULL DEFAULT 0 CHECK (redelivery_count >= 0),
  last_redelivered_at timestamptz,
  processing_state ugv_ingest.processing_state NOT NULL DEFAULT 'RECEIVED',
  processing_attempts integer NOT NULL DEFAULT 0,
  next_processing_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  mapper_policy_version text,
  canonical_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (packet_id IS NULL OR packet_id BETWEEN 1 AND 65535),
  UNIQUE (session_id,packet_id,packet_generation)
);

CREATE TABLE ugv_ingest.packet_slot (
  session_id uuid NOT NULL REFERENCES ugv_ingest.mqtt_session,
  packet_id integer NOT NULL CHECK (packet_id BETWEEN 1 AND 65535),
  generation bigint NOT NULL CHECK (generation > 0),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  message_id uuid NOT NULL REFERENCES ugv_ingest.inbox_message,
  puback_sent_at timestamptz,
  PRIMARY KEY (session_id,packet_id)
);

CREATE TABLE ugv_ingest.stream_cursor (
  device_id text NOT NULL,
  topic text NOT NULL,
  cursor_key text NOT NULL,
  last_source_sequence text,
  last_inbox_sequence bigint,
  last_source_time_raw text,
  last_payload_sha256 text,
  last_emitted_at timestamptz,
  authority_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  sampling_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  mission_epoch bigint NOT NULL DEFAULT 1,
  recon_epoch bigint NOT NULL DEFAULT 1,
  last_command_ack jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (device_id,topic,cursor_key)
);

CREATE TABLE ugv_ingest.outbox_message (
  outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_message_id uuid NOT NULL REFERENCES ugv_ingest.inbox_message,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  destination_kind ugv_ingest.destination_kind NOT NULL,
  destination_uri_kind text NOT NULL CHECK (destination_uri_kind IN ('CANONICAL_OBSERVATION_INGEST','OPERATIONAL_EVENT_INGEST')),
  idempotency_key text NOT NULL,
  request_headers jsonb NOT NULL CHECK (jsonb_typeof(request_headers)='object'),
  request_body jsonb NOT NULL,
  request_body_bytes bytea NOT NULL,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  delivery_state text NOT NULL DEFAULT 'PENDING' CHECK (delivery_state IN ('PENDING','DELIVERED','DEAD_LETTER')),
  delivery_attempts integer NOT NULL DEFAULT 0,
  next_delivery_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_http_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (inbox_message_id,ordinal),
  UNIQUE (destination_kind,idempotency_key)
);

CREATE INDEX ugv_ingest_inbox_pending_idx
  ON ugv_ingest.inbox_message(processing_state,next_processing_at,adapter_received_at);
CREATE INDEX ugv_ingest_inbox_topic_time_idx
  ON ugv_ingest.inbox_message(device_id,topic,adapter_received_at DESC);
CREATE INDEX ugv_ingest_outbox_pending_idx
  ON ugv_ingest.outbox_message(delivery_state,next_delivery_at,created_at);

-- MQTT.js waits for customHandleAcks before parsing the next PUBLISH. Keep the
-- complete QoS1 slot/inbox decision in one database statement so the durable
-- ACK boundary does not require a series of client/server round trips.
CREATE FUNCTION ugv_ingest.accept_message(
  p_session_id uuid,p_device_id text,p_topic text,p_packet_id integer,p_qos smallint,
  p_duplicate boolean,p_retained boolean,p_payload_size integer,p_payload_sha256 text,
  p_raw_payload bytea,p_decoded_payload jsonb,p_adapter_received_at timestamptz,
  p_validation_state text,p_validation_errors jsonb,p_maximum_pending integer
) RETURNS TABLE(accepted_message_id uuid,was_redelivery boolean,accepted_packet_generation bigint)
LANGUAGE plpgsql AS $function$
DECLARE
  v_generation bigint := 1;
  v_slot_hash text;
  v_slot_message_id uuid;
  v_puback_sent_at timestamptz;
  v_message_id uuid;
BEGIN
  IF p_qos=1 AND p_packet_id IS NOT NULL THEN
    SELECT ps.generation,ps.payload_sha256,ps.message_id,ps.puback_sent_at
      INTO v_generation,v_slot_hash,v_slot_message_id,v_puback_sent_at
      FROM ugv_ingest.packet_slot ps
      WHERE ps.session_id=p_session_id AND ps.packet_id=p_packet_id FOR UPDATE;
    IF FOUND AND v_puback_sent_at IS NULL AND p_duplicate THEN
      IF v_slot_hash<>p_payload_sha256 THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='MQTT_PACKET_CONFLICT: packet identifier redelivery has different payload';
      END IF;
      UPDATE ugv_ingest.inbox_message i SET redelivery_count=i.redelivery_count+1,
        last_redelivered_at=clock_timestamp() WHERE i.message_id=v_slot_message_id;
      RETURN QUERY SELECT v_slot_message_id,true,v_generation;
      RETURN;
    END IF;
    v_generation := CASE WHEN FOUND THEN v_generation+1 ELSE 1 END;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ugv_ingest.inbox_message i
      WHERE i.processing_state IN ('RECEIVED','VALIDATED','OUTBOXED')
      OFFSET GREATEST(p_maximum_pending-1,0) LIMIT 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INBOX_BACKPRESSURE: durable inbox backlog reached configured limit';
  END IF;

  v_message_id := gen_random_uuid();
  INSERT INTO ugv_ingest.inbox_message(
    message_id,session_id,device_id,topic,packet_id,packet_generation,qos,duplicate_flag,retained_flag,
    payload_size,payload_sha256,raw_payload,decoded_payload,adapter_received_at,schema_version,schema_hash,
    validation_state,validation_errors,processing_state,completed_at
  ) SELECT v_message_id,p_session_id,p_device_id,p_topic,p_packet_id,v_generation,p_qos,p_duplicate,p_retained,
      p_payload_size,p_payload_sha256,p_raw_payload,p_decoded_payload,p_adapter_received_at,'source-schema-v1',
      ms.source_schema_lock->>'topicSchemaHash',p_validation_state,p_validation_errors,
      CASE WHEN p_validation_state='VALID' THEN 'RECEIVED' ELSE 'DEAD_LETTER' END::ugv_ingest.processing_state,
      CASE WHEN p_validation_state='VALID' THEN NULL ELSE clock_timestamp() END
    FROM ugv_ingest.mqtt_session ms WHERE ms.session_id=p_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown MQTT session %',p_session_id; END IF;

  IF p_qos=1 AND p_packet_id IS NOT NULL THEN
    INSERT INTO ugv_ingest.packet_slot(session_id,packet_id,generation,payload_sha256,message_id,puback_sent_at)
      VALUES (p_session_id,p_packet_id,v_generation,p_payload_sha256,v_message_id,NULL)
      ON CONFLICT (session_id,packet_id) DO UPDATE SET generation=EXCLUDED.generation,
        payload_sha256=EXCLUDED.payload_sha256,message_id=EXCLUDED.message_id,puback_sent_at=NULL;
  END IF;
  RETURN QUERY SELECT v_message_id,false,v_generation;
END
$function$;

COMMENT ON SCHEMA ugv_ingest IS
  'Consumer-owned durable MQTT inbox, packet lifecycle, deterministic stream cursors and HTTP outbox.';
COMMENT ON COLUMN ugv_ingest.packet_slot.puback_sent_at IS
  'Set only after MQTT.js emits packetsend for the matching PUBACK; completed packet identifiers may then be reused.';

REVOKE ALL ON SCHEMA ugv_ingest FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA ugv_ingest FROM PUBLIC;
