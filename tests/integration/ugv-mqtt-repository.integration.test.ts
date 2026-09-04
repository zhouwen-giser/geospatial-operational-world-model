import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { mapUgvMessage,type MapperConfig } from "../../packages/integrations/ugv-mqtt-ingest-core/src/mapper.js";
import type { SourceSchemaLock } from "../../packages/integrations/ugv-mqtt-ingest-core/src/contracts.js";
import type { SourceSchemaRegistry } from "../../packages/integrations/ugv-mqtt-ingest-core/src/source-schema-registry.js";
import { UgvIngestRepository } from "../../services/ugv-mqtt-ingest/src/repository.js";
import { normalizeObservationInput } from "../../packages/observation-model/src/canonical.js";
import { ObservationRepository } from "../../packages/runtime/src/observation-repository.js";
import { CanonicalObservationInputSchema } from "../../packages/world-model-core/src/schema.js";

const databaseUrl = process.env.UGV_MQTT_TEST_DATABASE_URL;
if (!databaseUrl && process.env.npm_lifecycle_event === "validate:ugv-mqtt-db") {
  throw new Error("UGV_MQTT_TEST_DATABASE_URL is required for validate:ugv-mqtt-db");
}
const integration = databaseUrl ? describe : describe.skip;
const lock: SourceSchemaLock = {
  lockVersion: "1.0",sourceDirectory: "/immutable/source/schema",files: [],topicSchemaHash: "a".repeat(64),
  validatedTopics: ["/ugv/gnss","/ugv/speed","status/ugv","/ugv/mission_state","/ugv/area_recon/status",
    "/ugv/area_recon/targets","/ugv/area_recon/exception"],topicSchemas: {} as SourceSchemaLock["topicSchemas"],schemaDocuments: {}
};
const mapperConfig: MapperConfig = {
  deviceId: "ugv",dataScopeKey: "airport-sim-ugv-01",sourceKey: "ugv-airport-sim-mqtt",
  producerPipelineKey: "ugv-airport-sim-mqtt:canonical-v1",scenarioId: "airport",worldEpoch: "airport-run-001",
  trackerSessionKey: "airport-run-001:ugv",analysisSpaceKey: "airport-utm48n",analysisSrid: 32648,
  arrivalUncertaintyMs: 1000,mapperVersion: "ugv-mqtt-canonical-v1"
};

integration("UGV MQTT durable repository on isolated PostgreSQL",() => {
  let pool: pg.Pool;
  let repository: UgvIngestRepository;
  beforeAll(async () => {
    if (!databaseUrl) throw new Error("UGV_MQTT_TEST_DATABASE_URL is required");
    const databaseName = new URL(databaseUrl).pathname.slice(1);
    if (!/^gowm_ugv_ingest_acceptance_[a-z0-9_]+$/u.test(databaseName)) {
      throw new Error("UGV MQTT integration tests require a disposable gowm_ugv_ingest_acceptance_* database");
    }
    pool = new pg.Pool({ connectionString: databaseUrl,max: 2 });
    await pool.query("DELETE FROM ugv_ingest.outbox_message");
    await pool.query("DELETE FROM ugv_ingest.packet_slot");
    await pool.query("DELETE FROM ugv_ingest.stream_cursor");
    await pool.query("DELETE FROM ugv_ingest.inbox_message");
    await pool.query("DELETE FROM ugv_ingest.mqtt_session");
    const sourceSchemas = { validate: (_topic: string,data: unknown) => ({ success: true,data,errors: [] }) } as unknown as SourceSchemaRegistry;
    repository = new UgvIngestRepository(pool,"ugv",1_048_576,10_000,sourceSchemas);
  });
  afterAll(async () => { await pool?.end(); });

  it("commits before ACK, deduplicates DUP and preserves immutable outbox bytes",async () => {
    const session = await repository.startSession("gowm-ugv-test","broker:1883",false,lock,"integration-test");
    const payload = Buffer.from('{"latitude":29.7195,"longitude":106.81485,"altitude":500}');
    const first = await repository.accept(session.sessionId,"/ugv/gnss",payload,
      { messageId: 7,qos: 1,dup: false,retain: false },"2026-09-04T00:00:00.000Z");
    expect(first).toMatchObject({ redelivery: false,validationState: "VALID",packetGeneration: 1 });
    const committed = await pool.query<{ raw_payload: Buffer; puback_sent_at: Date | null }>(
      `SELECT i.raw_payload,s.puback_sent_at FROM ugv_ingest.inbox_message i
       JOIN ugv_ingest.packet_slot s ON s.message_id=i.message_id WHERE i.message_id=$1`,[first.messageId]
    );
    expect(committed.rows[0]?.raw_payload.equals(payload)).toBe(true);
    expect(committed.rows[0]?.puback_sent_at).toBeNull();

    const beforeAck = await repository.accept(session.sessionId,"/ugv/gnss",payload,
      { messageId: 7,qos: 1,dup: true,retain: false },"2026-09-04T00:00:00.100Z");
    expect(beforeAck).toMatchObject({ messageId: first.messageId,redelivery: true,packetGeneration: 1 });
    await expect(repository.accept(session.sessionId,"/ugv/gnss",Buffer.from('{"latitude":0,"longitude":0,"altitude":0}'),
      { messageId: 7,qos: 1,dup: true },"2026-09-04T00:00:00.200Z")).rejects.toMatchObject({ code: "MQTT_PACKET_CONFLICT" });
    await expect(repository.markPuback(session.sessionId,7,2)).rejects.toThrow(/generation/u);
    await repository.markPuback(session.sessionId,7,1);
    const afterAckDup = await repository.accept(session.sessionId,"/ugv/gnss",payload,
      { messageId: 7,qos: 1,dup: true },"2026-09-04T00:00:00.300Z");
    expect(afterAckDup.messageId).toBe(first.messageId);

    const ackWriteRace = await repository.accept(session.sessionId,"/ugv/gnss",payload,
      { messageId: 9,qos: 1,dup: false },"2026-09-04T00:00:00.400Z");
    const safelyReused = await repository.accept(session.sessionId,"/ugv/gnss",Buffer.from('{"latitude":29.72,"longitude":106.82,"altitude":501}'),
      { messageId: 9,qos: 1,dup: false },"2026-09-04T00:00:00.500Z");
    expect(safelyReused).toMatchObject({ redelivery: false,packetGeneration: 2 });
    await expect(repository.markPuback(session.sessionId,9,ackWriteRace.packetGeneration ?? 0)).rejects.toThrow(/generation/u);

    const pending = await repository.nextPending();
    expect(pending?.messageId).toBe(first.messageId);
    if (!pending) throw new Error("committed inbox message was not processable");
    await repository.storeMapping(pending,mapUgvMessage(pending,mapperConfig),mapperConfig.mapperVersion);
    const outbox = await repository.nextOutbox();
    expect(outbox?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(outbox?.bodyBytes.toString("utf8") ?? "null")).toMatchObject({ observationType: "UGV_POSITION" });
    if (!outbox) throw new Error("mapped observation did not create an outbox row");
    await repository.deliveryResult(outbox.outboxId,{ delivered: true,status: 202,attempts: outbox.attempts });
    expect((await pool.query("SELECT processing_state FROM ugv_ingest.inbox_message WHERE message_id=$1",[first.messageId])).rows[0]?.processing_state).toBe("DELIVERED");

    await pool.query("UPDATE ugv_ingest.outbox_message SET delivery_state='PENDING',request_body_bytes='tampered'::bytea,next_delivery_at=clock_timestamp() WHERE outbox_id=$1",[outbox.outboxId]);
    await expect(repository.nextOutbox()).rejects.toThrow(/immutable body hash mismatch/u);
    await pool.query("UPDATE ugv_ingest.outbox_message SET request_body_bytes=convert_to(request_body::text,'UTF8'),body_sha256=encode(digest(convert_to(request_body::text,'UTF8'),'sha256'),'hex') WHERE outbox_id=$1",[outbox.outboxId]);
    const permanent = await repository.nextOutbox();
    if (!permanent) throw new Error("repaired outbox was not pending");
    await repository.deliveryResult(permanent.outboxId,{ permanent: true,status: 422,error: "HTTP_422",attempts: permanent.attempts });
    expect((await pool.query("SELECT processing_state FROM ugv_ingest.inbox_message WHERE message_id=$1",[first.messageId])).rows[0]?.processing_state).toBe("DEAD_LETTER");

    const reused = await repository.accept(session.sessionId,"/ugv/gnss",Buffer.from('{"latitude":29.72,"longitude":106.82,"altitude":501}'),
      { messageId: 7,qos: 1,dup: false },"2026-09-04T00:00:01.000Z");
    expect(reused).toMatchObject({ redelivery: false,packetGeneration: 2 });
    expect(reused.messageId).not.toBe(first.messageId);

    const poisonBytes = Buffer.from("{not-json");
    const poison = await repository.accept(session.sessionId,"/ugv/gnss",poisonBytes,
      { messageId: 8,qos: 1,dup: false },"2026-09-04T00:00:02.000Z");
    expect(poison.validationState).toBe("NON_JSON");
    const poisonRow = await pool.query<{ raw_payload: Buffer; processing_state: string }>(
      "SELECT raw_payload,processing_state FROM ugv_ingest.inbox_message WHERE message_id=$1",[poison.messageId]
    );
    expect(poisonRow.rows[0]?.raw_payload.equals(poisonBytes)).toBe(true);
    expect(poisonRow.rows[0]?.processing_state).toBe("DEAD_LETTER");
    expect((await pool.query("SELECT count(*)::int AS count FROM ugv_ingest.inbox_message WHERE packet_id=7")).rows[0]?.count).toBe(2);
  });

  it("projects sourceGeometry in the named EPSG:32648 analysis space and rejects client drift",async () => {
    const observationRepository = new ObservationRepository(pool);
    const message = {
      messageId: randomUUID(),topic: "/ugv/gnss" as const,
      payloadSha256: "b".repeat(64),payload: { latitude: 29.7195,longitude: 106.81485,altitude: 500 },
      adapterReceivedAt: "2026-09-04T01:00:00.000Z",retained: false,cursor: {}
    };
    const candidate = mapUgvMessage(message,mapperConfig).observations[0];
    if (!candidate) throw new Error("GNSS mapper produced no observation");
    const bundle = normalizeObservationInput(candidate,"2026-09-04T01:00:00.100Z");
    const inserted = await observationRepository.insert(bundle,{ project: false });
    expect(inserted.status).toBe("accepted");
    const projected = await pool.query<{ source_srid: number; position_srid: number; x: number; y: number; expected_x: number; expected_y: number }>(
      `SELECT ST_SRID(pm.source_position) AS source_srid,ST_SRID(pm.position) AS position_srid,
              ST_X(pm.position) AS x,ST_Y(pm.position) AS y,
              ST_X(ST_Transform(pm.source_position,32648)) AS expected_x,
              ST_Y(ST_Transform(pm.source_position,32648)) AS expected_y
       FROM position_measurement pm JOIN measurement m USING(measurement_id) WHERE m.observation_id=$1`,
      [candidate.observationId]
    );
    expect(projected.rows[0]).toMatchObject({ source_srid: 4326,position_srid: 32648 });
    expect(Number(projected.rows[0]?.x)).toBeCloseTo(Number(projected.rows[0]?.expected_x),6);
    expect(Number(projected.rows[0]?.y)).toBeCloseTo(Number(projected.rows[0]?.expected_y),6);
    expect((await observationRepository.insert(bundle,{ project: false })).status).toBe("duplicate");

    const position = { x: Number(projected.rows[0]?.x),y: Number(projected.rows[0]?.y),srid: 32648 };
    const consistent = CanonicalObservationInputSchema.parse({ ...candidate,
      observationId: `${candidate.observationId}-consistent`,sourceRecordKey: `${candidate.sourceRecordKey}:consistent`,
      measurements: candidate.measurements.map((measurement) => measurement.resultKind === "POSITION" ? { ...measurement,position } : measurement)
    });
    expect((await observationRepository.insert(normalizeObservationInput(consistent,"2026-09-04T01:00:00.200Z"),{ project: false })).status).toBe("accepted");
    const drifted = CanonicalObservationInputSchema.parse({ ...candidate,
      observationId: `${candidate.observationId}-drifted`,sourceRecordKey: `${candidate.sourceRecordKey}:drifted`,
      measurements: candidate.measurements.map((measurement) => measurement.resultKind === "POSITION" ?
        { ...measurement,position: { x: position.x + 1,y: position.y,srid: 32648 } } : measurement)
    });
    await expect(observationRepository.insert(normalizeObservationInput(drifted,"2026-09-04T01:00:00.300Z"),{ project: false }))
      .rejects.toMatchObject({ code: "POSITION_TRANSFORM_MISMATCH",statusCode: 422 });
    expect(CanonicalObservationInputSchema.safeParse({ ...candidate,
      measurements: candidate.measurements.map((measurement) => measurement.resultKind === "POSITION" ?
        { ...measurement,sourceGeometry: { type: "Point",coordinates: [181,29.7] } } : measurement)
    }).success).toBe(false);
  });
});
