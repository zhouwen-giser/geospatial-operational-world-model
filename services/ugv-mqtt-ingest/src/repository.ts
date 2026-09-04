import { createHash } from "node:crypto";
import type pg from "pg";
import { withTransaction } from "../../../packages/runtime/src/db.js";
import { decodePayload, type SourceSchemaLock, type UgvAuthorityTopic } from "../../../packages/integrations/ugv-mqtt-ingest-core/src/contracts.js";
import { SourceSchemaRegistry } from "../../../packages/integrations/ugv-mqtt-ingest-core/src/source-schema-registry.js";
import type { MapperConfig, MappingResult } from "../../../packages/integrations/ugv-mqtt-ingest-core/src/mapper.js";
import { CanonicalObservationInputSchema } from "../../../packages/world-model-core/src/schema.js";
import { OperationalEventIngestSchema } from "../../../packages/operational-model/src/events.js";
import { canonicalJson } from "../../../packages/observation-model/src/canonical.js";

export interface AcceptedMessage { messageId: string; redelivery: boolean; validationState: string; packetGeneration?: number; }
export interface PendingMessage {
  messageId: string; topic: UgvAuthorityTopic; payloadSha256: string; payload: unknown;
  adapterReceivedAt: string; retained: boolean; ingestSequence: number;
  cursor: Record<string,unknown>; streamContext: Record<string,unknown>;
  mapperConfig: MapperConfig; streamNamespace: string;
}

export class UgvIngestRepository {
  constructor(private readonly pool: pg.Pool,private readonly deviceId: string,private readonly maximumPayloadBytes: number,
    private readonly maximumPendingInbox = 10_000,private readonly sourceSchemas?: SourceSchemaRegistry) {}

  async startSession(clientId: string,brokerId: string,sessionPresent: boolean,sourceLock: SourceSchemaLock,
    codeVersion: string,mapperContext: MapperConfig): Promise<{ sessionId: string; sessionLost: boolean }> {
    return withTransaction(this.pool,async (client) => {
      const mapperContextJson = canonicalJson(mapperContext);
      const mapperContextHash = createHash("sha256").update(mapperContextJson).digest("hex");
      const previous = await client.query<{ session_id: string; session_epoch: string; source_schema_lock: SourceSchemaLock; mapper_context_hash: string }>(
        `SELECT session_id,session_epoch,source_schema_lock,mapper_context_hash FROM ugv_ingest.mqtt_session
          WHERE client_id=$1 AND broker_id=$2 ORDER BY session_epoch DESC LIMIT 1 FOR UPDATE`,
        [clientId,brokerId]
      );
      const priorEpoch = Number(previous.rows[0]?.session_epoch ?? 0);
      const sessionLost = priorEpoch > 0 && !sessionPresent;
      if (sessionPresent && previous.rows[0] && canonicalJson(previous.rows[0].source_schema_lock) !== canonicalJson(sourceLock)) {
        throw Object.assign(new Error("source schema lock changed while the persistent MQTT session is active"),{
          code: "SOURCE_SCHEMA_LOCK_CHANGED_WITH_ACTIVE_SESSION"
        });
      }
      if (sessionPresent && previous.rows[0] && previous.rows[0].mapper_context_hash !== mapperContextHash) {
        throw Object.assign(new Error("mapper context changed while the persistent MQTT session is active"),{
          code: "MAPPER_CONTEXT_CHANGED_WITH_ACTIVE_SESSION"
        });
      }
      const incompatiblePending = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ugv_ingest.inbox_message inbox
           JOIN ugv_ingest.mqtt_session session USING(session_id)
          WHERE session.client_id=$1 AND session.broker_id=$2
            AND inbox.processing_state IN ('RECEIVED','VALIDATED','OUTBOXED')
            AND session.mapper_context_hash<>$3`,[clientId,brokerId,mapperContextHash]
      );
      if (Number(incompatiblePending.rows[0]?.count ?? 0)>0) {
        throw Object.assign(new Error("mapper context changed while an earlier inbox remains pending"),{
          code: "MAPPER_CONTEXT_CHANGED_WITH_PENDING_INBOX"
        });
      }
      const epoch = sessionPresent && priorEpoch > 0 ? priorEpoch : priorEpoch + 1;
      if (sessionLost && previous.rows[0]) {
        await client.query(`UPDATE ugv_ingest.mqtt_session SET disconnected_at=COALESCE(disconnected_at,clock_timestamp()),
          disconnect_reason='MQTT_SESSION_LOST' WHERE session_id=$1`,[previous.rows[0].session_id]);
      }
      const result = await client.query<{ session_id: string }>(
        `INSERT INTO ugv_ingest.mqtt_session(client_id,broker_id,session_epoch,session_present,protocol_version,source_schema_lock,mapper_context,mapper_context_hash,code_version)
         VALUES ($1,$2,$3,$4,5,$5::jsonb,$6::jsonb,$7,$8)
         ON CONFLICT (client_id,broker_id,session_epoch) DO UPDATE SET session_present=EXCLUDED.session_present,
           connected_at=clock_timestamp(),disconnected_at=NULL,disconnect_reason=NULL,source_schema_lock=EXCLUDED.source_schema_lock,
           mapper_context=EXCLUDED.mapper_context,mapper_context_hash=EXCLUDED.mapper_context_hash,
           code_version=EXCLUDED.code_version RETURNING session_id`,
        [clientId,brokerId,epoch,sessionPresent,JSON.stringify(sourceLock),mapperContextJson,mapperContextHash,codeVersion]
      );
      const id = result.rows[0]?.session_id;
      if (!id) throw new Error("failed to create MQTT session record");
      return { sessionId: id,sessionLost };
    });
  }

  async setSubscriptions(sessionId: string,acks: Record<string,number>): Promise<void> {
    await this.pool.query(`UPDATE ugv_ingest.mqtt_session SET subscription_acks=$2::jsonb WHERE session_id=$1`,[sessionId,JSON.stringify(acks)]);
  }

  async disconnect(sessionId: string,reason: string): Promise<void> {
    await this.pool.query(`UPDATE ugv_ingest.mqtt_session SET disconnected_at=clock_timestamp(),disconnect_reason=$2 WHERE session_id=$1`,[sessionId,reason.slice(0,512)]);
  }

  async accept(sessionId: string,topic: UgvAuthorityTopic,payload: Buffer,packet: { messageId?: number; qos: number; dup?: boolean; retain?: boolean },receivedAt: string): Promise<AcceptedMessage> {
    const hash = createHash("sha256").update(payload).digest("hex");
    let decoded: unknown; let validationState = "VALID"; let validationErrors: unknown[] = [];
    if (payload.byteLength > this.maximumPayloadBytes) {
      validationState = "PAYLOAD_TOO_LARGE"; validationErrors = [{ maximumBytes: this.maximumPayloadBytes,actualBytes: payload.byteLength }];
    } else {
      try {
        decoded = decodePayload(topic,payload);
        const validation = this.sourceSchemas?.validate(topic,decoded);
        if (!validation) throw new Error("source schema registry is not loaded");
        if (!validation.success) { validationState = "SCHEMA_INVALID"; validationErrors = validation.errors; }
        else decoded = validation.data;
      } catch (error) {
        validationState = "NON_JSON"; validationErrors = [{ message: error instanceof Error ? error.message : String(error) }];
      }
    }
    try {
      const accepted = await this.pool.query<{ accepted_message_id: string; was_redelivery: boolean; accepted_packet_generation: string }>(
        `SELECT * FROM ugv_ingest.accept_message($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb,$15)`,
        [sessionId,this.deviceId,topic,packet.messageId ?? null,packet.qos,packet.dup ?? false,packet.retain ?? false,
          payload.byteLength,hash,payload,decoded === undefined ? null : JSON.stringify(decoded),receivedAt,validationState,
          JSON.stringify(validationErrors),this.maximumPendingInbox]
      );
      const row = accepted.rows[0];
      if (!row) throw new Error("durable MQTT accept returned no result");
      return { messageId: row.accepted_message_id,redelivery: row.was_redelivery,validationState,
        ...(packet.qos === 1 ? { packetGeneration: Number(row.accepted_packet_generation) } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("MQTT_PACKET_CONFLICT:")) throw Object.assign(new Error(message.slice(22).trim()),{ code: "MQTT_PACKET_CONFLICT" });
      if (message.startsWith("INBOX_BACKPRESSURE:")) throw Object.assign(new Error(message.slice(19).trim()),{ code: "INBOX_BACKPRESSURE" });
      throw error;
    }
  }

  async markPuback(sessionId: string,packetId: number,generation: number): Promise<void> {
    const result = await this.pool.query(
      `UPDATE ugv_ingest.packet_slot SET puback_sent_at=clock_timestamp()
       WHERE session_id=$1 AND packet_id=$2 AND generation=$3`,
      [sessionId,packetId,generation]
    );
    if (result.rowCount !== 1) throw new Error("PUBACK packet generation no longer matches its durable inbox slot");
  }

  async nextPending(clientId: string,brokerId: string): Promise<PendingMessage | undefined> {
    return withTransaction(this.pool,async (client) => {
      const result = await client.query<{
        message_id: string; topic: UgvAuthorityTopic; payload_sha256: string; decoded_payload: unknown;
        adapter_received_at: Date; retained_flag: boolean; ingest_sequence: string;
        mapper_context: MapperConfig; mapper_context_hash: string;
      }>(`SELECT inbox.message_id,inbox.topic,inbox.payload_sha256,inbox.decoded_payload,inbox.adapter_received_at,
                 inbox.retained_flag,inbox.ingest_sequence,session.mapper_context,session.mapper_context_hash
          FROM ugv_ingest.inbox_message inbox JOIN ugv_ingest.mqtt_session session USING(session_id)
          WHERE session.client_id=$1 AND session.broker_id=$2 AND inbox.processing_state IN ('RECEIVED','VALIDATED')
            AND inbox.next_processing_at<=clock_timestamp()
          ORDER BY inbox.ingest_sequence LIMIT 1 FOR UPDATE OF inbox SKIP LOCKED`,[clientId,brokerId]);
      const row = result.rows[0]; if (!row) return undefined;
      const mapperConfig = validatedMapperConfig(row.mapper_context);
      const actualContextHash = createHash("sha256").update(canonicalJson(mapperConfig)).digest("hex");
      if (actualContextHash !== row.mapper_context_hash) {
        throw new Error(`persisted mapper context hash mismatch for inbox ${row.message_id}`);
      }
      await client.query(`UPDATE ugv_ingest.inbox_message SET processing_attempts=processing_attempts+1,processing_state='VALIDATED' WHERE message_id=$1`,[row.message_id]);
      const authorityCursorKey = `authority:${row.mapper_context_hash}`;
      const sharedCursorKey = `shared:${row.mapper_context_hash}`;
      const cursorResult = await client.query<{ topic: string; cursor_key: string; authority_state: Record<string,unknown>; sampling_state: Record<string,unknown>; mission_epoch: string; recon_epoch: string; last_command_ack: unknown }>(
        `SELECT topic,cursor_key,authority_state,sampling_state,mission_epoch,recon_epoch,last_command_ack
           FROM ugv_ingest.stream_cursor
          WHERE device_id=$1 AND ((topic=$2 AND cursor_key=$3) OR (topic='*' AND cursor_key=$4))`,
        [this.deviceId,row.topic,authorityCursorKey,sharedCursorKey]
      );
      const stored = cursorResult.rows.find((candidate) => candidate.cursor_key === authorityCursorKey);
      const shared = cursorResult.rows.find((candidate) => candidate.cursor_key === sharedCursorKey);
      const cursor = stored ? { ...stored.authority_state,...stored.sampling_state,missionEpoch: Number(stored.mission_epoch),reconEpoch: Number(stored.recon_epoch),lastCommandAck: stored.last_command_ack } : {};
      return { messageId: row.message_id,topic: row.topic,payloadSha256: row.payload_sha256,payload: row.decoded_payload,
        adapterReceivedAt: row.adapter_received_at.toISOString(),retained: row.retained_flag,ingestSequence: Number(row.ingest_sequence),
        cursor,streamContext: shared?.authority_state ?? {},mapperConfig,
        streamNamespace: row.mapper_context_hash };
    });
  }

  async storeMapping(message: PendingMessage,mapping: MappingResult,mapperVersion: string): Promise<void> {
    await withTransaction(this.pool,async (client) => {
      const bodies = [
        ...mapping.observations.map((candidate) => {
          const body = CanonicalObservationInputSchema.parse(candidate);
          return { kind: "OBSERVATION" as const,body,key: body.observationId };
        }),
        ...mapping.events.map((candidate) => {
          const body = OperationalEventIngestSchema.parse(candidate);
          return { kind: "OPERATIONAL_EVENT" as const,body,key: body.eventId };
        })
      ];
      for (const [ordinal,item] of bodies.entries()) {
        const json = JSON.stringify(item.body); const hash = createHash("sha256").update(json).digest("hex");
        await client.query(
          `INSERT INTO ugv_ingest.outbox_message(
             inbox_message_id,ordinal,destination_kind,destination_uri_kind,idempotency_key,request_headers,
             request_body,request_body_bytes,body_sha256
           ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)
           ON CONFLICT (destination_kind,idempotency_key) DO NOTHING`,
          [message.messageId,ordinal,item.kind,
           item.kind === "OBSERVATION" ? "CANONICAL_OBSERVATION_INGEST" : "OPERATIONAL_EVENT_INGEST",
           item.key,JSON.stringify({ "content-type": "application/json",
             ...(item.kind === "OPERATIONAL_EVENT" ? { "x-data-scope-key": item.body.dataScopeKey } : {}) }),
           json,Buffer.from(json,"utf8"),hash]
        );
      }
      if (bodies.length === 0 && !mapping.ignoredReason) {
        throw new Error("mapper returned neither output nor an explicit ignored reason");
      }
      const finalState = mapping.ignoredReason ? "IGNORED_BY_POLICY" : "OUTBOXED";
      await client.query(`UPDATE ugv_ingest.inbox_message SET processing_state=$2::ugv_ingest.processing_state,mapper_policy_version=$3,
        canonical_ids=$4::jsonb,completed_at=CASE WHEN $2='IGNORED_BY_POLICY' THEN clock_timestamp() ELSE NULL END WHERE message_id=$1`,
        [message.messageId,finalState,mapperVersion,JSON.stringify(bodies.map((item) => item.key))]);
      await client.query(
        `INSERT INTO ugv_ingest.stream_cursor(device_id,topic,cursor_key,last_inbox_sequence,last_payload_sha256,authority_state,sampling_state,mission_epoch,recon_epoch,last_command_ack,last_emitted_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb,$11)
         ON CONFLICT (device_id,topic,cursor_key) DO UPDATE SET last_payload_sha256=EXCLUDED.last_payload_sha256,
           last_inbox_sequence=EXCLUDED.last_inbox_sequence,authority_state=EXCLUDED.authority_state,sampling_state=EXCLUDED.sampling_state,
           mission_epoch=EXCLUDED.mission_epoch,recon_epoch=EXCLUDED.recon_epoch,last_command_ack=EXCLUDED.last_command_ack,
           last_emitted_at=EXCLUDED.last_emitted_at,updated_at=clock_timestamp()`,
        [this.deviceId,message.topic,`authority:${message.streamNamespace}`,message.ingestSequence,message.payloadSha256,
         JSON.stringify(mapping.cursor),JSON.stringify(samplingCursor(mapping.cursor)),
         Number(mapping.cursor.missionEpoch ?? 1),Number(mapping.cursor.reconEpoch ?? 1),
         mapping.cursor.lastCommandAck ? JSON.stringify(mapping.cursor.lastCommandAck) : null,
         typeof mapping.cursor.lastEmittedAt === "string" ? mapping.cursor.lastEmittedAt : null]
      );
      if (mapping.streamContext) {
        await client.query(
          `INSERT INTO ugv_ingest.stream_cursor(device_id,topic,cursor_key,last_inbox_sequence,last_payload_sha256,authority_state)
           VALUES ($1,'*',$2,$3,$4,$5::jsonb)
           ON CONFLICT (device_id,topic,cursor_key) DO UPDATE SET last_inbox_sequence=EXCLUDED.last_inbox_sequence,
             last_payload_sha256=EXCLUDED.last_payload_sha256,authority_state=EXCLUDED.authority_state,updated_at=clock_timestamp()`,
          [this.deviceId,`shared:${message.streamNamespace}`,message.ingestSequence,message.payloadSha256,JSON.stringify(mapping.streamContext)]
        );
      }
    });
  }

  async failMapping(messageId: string,error: unknown): Promise<void> {
    await this.pool.query(`UPDATE ugv_ingest.inbox_message SET processing_state='DEAD_LETTER',last_error=$2,completed_at=clock_timestamp() WHERE message_id=$1`,
      [messageId,(error instanceof Error ? error.message : String(error)).slice(0,2048)]);
  }

  async nextOutbox(): Promise<{ outboxId: string; kind: "OBSERVATION" | "OPERATIONAL_EVENT"; bodyBytes: Buffer; headers: Record<string,string>; attempts: number } | undefined> {
    const result = await this.pool.query<{ outbox_id: string; destination_kind: "OBSERVATION" | "OPERATIONAL_EVENT"; request_body_bytes: Buffer; request_headers: Record<string,string>; body_sha256: string; delivery_attempts: number }>(
      `UPDATE ugv_ingest.outbox_message SET delivery_attempts=delivery_attempts+1
       WHERE outbox_id=(SELECT outbox_id FROM ugv_ingest.outbox_message WHERE delivery_state='PENDING' AND next_delivery_at<=clock_timestamp()
         ORDER BY created_at,outbox_id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING outbox_id,destination_kind,request_body_bytes,request_headers,body_sha256,delivery_attempts`
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const actual = createHash("sha256").update(row.request_body_bytes).digest("hex");
    if (actual !== row.body_sha256) throw new Error(`outbox ${row.outbox_id} immutable body hash mismatch`);
    return { outboxId: row.outbox_id,kind: row.destination_kind,bodyBytes: row.request_body_bytes,
      headers: row.request_headers,attempts: row.delivery_attempts };
  }

  async deliveryResult(outboxId: string,result: { delivered?: boolean; permanent?: boolean; status?: number; error?: string; attempts: number }): Promise<void> {
    const state = result.delivered ? "DELIVERED" : result.permanent ? "DEAD_LETTER" : "PENDING";
    const delaySeconds = Math.min(300,2 ** Math.min(result.attempts,8));
    await this.pool.query(`UPDATE ugv_ingest.outbox_message SET delivery_state=$2,last_http_status=$3,last_error=$4,
      delivered_at=CASE WHEN $2='DELIVERED' THEN clock_timestamp() ELSE NULL END,
      next_delivery_at=CASE WHEN $2='PENDING' THEN clock_timestamp()+make_interval(secs=>$5) ELSE next_delivery_at END WHERE outbox_id=$1`,
      [outboxId,state,result.status ?? null,result.error?.slice(0,2048) ?? null,delaySeconds]);
    if (result.permanent) await this.pool.query(`UPDATE ugv_ingest.inbox_message i
      SET processing_state='DEAD_LETTER',last_error=$2,completed_at=clock_timestamp()
      WHERE i.message_id=(SELECT inbox_message_id FROM ugv_ingest.outbox_message WHERE outbox_id=$1)`,
    [outboxId,result.error?.slice(0,2048) ?? `HTTP_${result.status ?? "PERMANENT"}`]);
    if (result.delivered) await this.pool.query(`UPDATE ugv_ingest.inbox_message i SET processing_state='DELIVERED',completed_at=clock_timestamp()
      WHERE i.message_id=(SELECT inbox_message_id FROM ugv_ingest.outbox_message WHERE outbox_id=$1)
      AND NOT EXISTS (SELECT 1 FROM ugv_ingest.outbox_message o WHERE o.inbox_message_id=i.message_id AND o.delivery_state<>'DELIVERED')`,[outboxId]);
  }

  async status(): Promise<Record<string,unknown>> {
    const result = await this.pool.query(`SELECT
      count(*) FILTER (WHERE processing_state IN ('RECEIVED','VALIDATED','OUTBOXED'))::int AS inbox_pending,
      count(*) FILTER (WHERE processing_state='DEAD_LETTER')::int AS inbox_dead_letter,
      (SELECT count(*)::int FROM ugv_ingest.outbox_message WHERE delivery_state='PENDING') AS outbox_pending,
      (SELECT count(*)::int FROM ugv_ingest.outbox_message WHERE delivery_state='PENDING' AND destination_kind='OBSERVATION') AS outbox_pending_observation,
      (SELECT count(*)::int FROM ugv_ingest.outbox_message WHERE delivery_state='PENDING' AND destination_kind='OPERATIONAL_EVENT') AS outbox_pending_operational_event,
      (SELECT COALESCE(EXTRACT(epoch FROM clock_timestamp()-min(created_at)),0) FROM ugv_ingest.outbox_message WHERE delivery_state='PENDING') AS outbox_oldest_age_seconds,
      COALESCE(sum(redelivery_count),0)::bigint AS persisted_redelivery_count
      FROM ugv_ingest.inbox_message`);
    return result.rows[0] ?? {};
  }
}

function samplingCursor(cursor: Record<string,unknown>): Record<string,unknown> {
  return Object.fromEntries(Object.entries(cursor).filter(([key]) =>
    key.startsWith("lastEmitted") || key === "lastCoverage" || key === "lastProgress" || key === "targets"));
}

function validatedMapperConfig(value: unknown): MapperConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("persisted mapper context is not an object");
  const record = value as Record<string,unknown>;
  for (const key of ["deviceId","dataScopeKey","sourceKey","producerPipelineKey","scenarioId","worldEpoch",
    "trackerSessionKey","analysisSpaceKey","mapperVersion"] as const) {
    if (typeof record[key] !== "string" || record[key].length === 0) throw new Error(`persisted mapper context has invalid ${key}`);
  }
  for (const key of ["analysisSrid","arrivalUncertaintyMs"] as const) {
    if (!Number.isSafeInteger(record[key]) || Number(record[key]) <= 0) throw new Error(`persisted mapper context has invalid ${key}`);
  }
  if (record.maxTargetsPerFrame !== undefined && (!Number.isSafeInteger(record.maxTargetsPerFrame) || Number(record.maxTargetsPerFrame) <= 0)) {
    throw new Error("persisted mapper context has invalid maxTargetsPerFrame");
  }
  if (record.samplingPolicy !== undefined && (!record.samplingPolicy || typeof record.samplingPolicy !== "object" || Array.isArray(record.samplingPolicy))) {
    throw new Error("persisted mapper context has invalid samplingPolicy");
  }
  return record as unknown as MapperConfig;
}
