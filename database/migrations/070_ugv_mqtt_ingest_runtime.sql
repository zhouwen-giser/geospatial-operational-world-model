CREATE SCHEMA ugv_ingest;

CREATE TYPE ugv_ingest.processing_state AS ENUM (
  'RECEIVED','VALIDATED','MAPPED','OUTBOXED','DELIVERED','IGNORED_BY_POLICY','DEAD_LETTER'
);
CREATE TYPE ugv_ingest.destination_kind AS ENUM ('OBSERVATION','OPERATIONAL_EVENT');

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
  code_version text NOT NULL,
  UNIQUE (client_id,broker_id,session_epoch)
);

CREATE TABLE ugv_ingest.inbox_message (
  message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
  idempotency_key text NOT NULL,
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

COMMENT ON SCHEMA ugv_ingest IS
  'Consumer-owned durable MQTT inbox, packet lifecycle, deterministic stream cursors and HTTP outbox.';
COMMENT ON COLUMN ugv_ingest.packet_slot.puback_sent_at IS
  'Set only after MQTT.js emits packetsend for the matching PUBACK; completed packet identifiers may then be reused.';

REVOKE ALL ON SCHEMA ugv_ingest FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA ugv_ingest FROM PUBLIC;
