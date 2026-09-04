import Fastify, { type FastifyInstance } from "fastify";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import pg from "pg";
import { loadSourceSchemaLock, UGV_AUTHORITY_TOPICS, type UgvAuthorityTopic } from "../../../packages/integrations/ugv-mqtt-ingest-core/src/contracts.js";
import { mapUgvMessage, type MapperConfig } from "../../../packages/integrations/ugv-mqtt-ingest-core/src/mapper.js";
import { loadUgvIngestConfig, type UgvIngestConfig } from "./config.js";
import { UgvIngestRepository } from "./repository.js";

interface RuntimeState {
  connected: boolean; sessionPresent: boolean; sessionId?: string; subscriptions: Record<string,number>;
  sourceLockLoaded: boolean; workerHealthy: boolean; lastApiSuccessAt?: string; lastError?: string;
  messages: Record<string,number>; redeliveries: Record<string,number>; invalid: Record<string,number>;
  sourceQosConflicts: Record<string,number>;
}

export async function buildUgvMqttIngestApp(): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const config = await loadUgvIngestConfig();
  const schemaDirectory = process.env.UGV_EQUIPMENT_SCHEMA_DIR;
  if (!schemaDirectory) throw new Error("UGV_EQUIPMENT_SCHEMA_DIR is required");
  const sourceLock = await loadSourceSchemaLock(schemaDirectory);
  const pool = new pg.Pool({ connectionString: config.databaseUrl,max: 8 });
  await pool.query("SELECT 1");
  const repository = new UgvIngestRepository(pool,config.deviceId,config.maxPayloadBytes);
  const state: RuntimeState = { connected: false,sessionPresent: false,subscriptions: {},sourceLockLoaded: true,
    workerHealthy: true,messages: {},redeliveries: {},invalid: {},sourceQosConflicts: {} };
  let sessionId: string | undefined;
  const options: IClientOptions = {
    protocolVersion: 5,clean: false,clientId: config.clientId,keepalive: config.keepaliveSeconds,
    connectTimeout: config.connectTimeoutMs,reconnectPeriod: 1000,resubscribe: false,
    properties: { sessionExpiryInterval: config.sessionExpirySeconds },
    ...(config.username ? { username: config.username } : {}),...(config.password ? { password: config.password } : {}),
    ...(config.ca ? { ca: config.ca } : {}),...(config.cert ? { cert: config.cert } : {}),...(config.key ? { key: config.key } : {}),
    customHandleAcks: (topic,payload,packet,done) => {
      if (!isTopic(topic) || !sessionId) return done(135);
      const receivedAt = new Date().toISOString();
      void repository.accept(sessionId,topic,payload,packet,receivedAt).then((accepted) => {
        increment(state.messages,topic); if (accepted.redelivery) increment(state.redeliveries,topic);
        if (accepted.validationState !== "VALID") increment(state.invalid,topic);
        done(0);
      }).catch((error) => {
        state.lastError = safeError(error);
        done(error instanceof Error ? error : new Error(String(error)),131);
      });
    }
  };
  const client = mqtt.connect(config.mqttUrl,options);
  wireClient(client,config,sourceLock,repository,state,(value) => { sessionId = value; state.sessionId = value; });

  const processTimer = setInterval(() => void processOne(repository,mapperConfig(config),state),25);
  const deliveryTimer = setInterval(() => void deliverOne(repository,config,state),50);
  processTimer.unref(); deliveryTimer.unref();

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  app.get("/health/live",async () => ({ status: "ok",service: "ugv-mqtt-ingest" }));
  app.get("/health/ready",async (_request,reply) => {
    const dbWritable = await writable(pool);
    const subscriptionsReady = UGV_AUTHORITY_TOPICS.every((topic) => state.subscriptions[topic] === 1);
    const sourceContractValid = Object.values(state.sourceQosConflicts).every((count) => count === 0);
    const ready = dbWritable && state.connected && subscriptionsReady && state.sourceLockLoaded && state.workerHealthy && sourceContractValid;
    return reply.code(ready ? 200 : 503).send({ ready,dbWritable,mqttConnected: state.connected,subscriptionsReady,
      sourceLockLoaded: state.sourceLockLoaded,outboxWorkerHealthy: state.workerHealthy,sourceContractValid,recoverableApiDegradation: !state.lastApiSuccessAt });
  });
  app.get("/v1/ingest/status",async () => ({ ...await repository.status(),mqttConnected: state.connected,
    mqttSessionPresent: state.sessionPresent,subscriptions: state.subscriptions,sourceQosConflicts: state.sourceQosConflicts,
    lastApiSuccessAt: state.lastApiSuccessAt,lastError: state.lastError ?? null }));
  app.get("/metrics",async (_request,reply) => reply.type("text/plain; version=0.0.4").send(metrics(state,await repository.status())));
  return { app,close: async () => {
    clearInterval(processTimer); clearInterval(deliveryTimer);
    if (sessionId) await repository.disconnect(sessionId,"graceful_shutdown").catch(() => undefined);
    await new Promise<void>((resolve,reject) => client.end(false,{},(error) => error ? reject(error) : resolve())); await pool.end(); await app.close();
  } };
}

function wireClient(client: MqttClient,config: UgvIngestConfig,sourceLock: Awaited<ReturnType<typeof loadSourceSchemaLock>>,
  repository: UgvIngestRepository,state: RuntimeState,setSession: (id: string) => void): void {
  client.on("connect",(connack) => void (async () => {
    state.connected = true; state.sessionPresent = connack.sessionPresent;
    const session = await repository.startSession(config.clientId,new URL(config.mqttUrl).host,connack.sessionPresent,sourceLock,config.codeVersion);
    setSession(session);
    const requests = Object.fromEntries(UGV_AUTHORITY_TOPICS.map((topic) => [topic,{ qos: 1 as const }]));
    const grants = await client.subscribeAsync(requests);
    state.subscriptions = Object.fromEntries(grants.map((grant) => [grant.topic,grant.qos]));
    await repository.setSubscriptions(session,state.subscriptions);
  })().catch((error) => { state.lastError = safeError(error); client.end(true); }));
  client.on("packetsend",(packet) => {
    if (packet.cmd === "puback" && state.sessionId && packet.messageId !== undefined) void repository.markPuback(state.sessionId,packet.messageId).catch((error) => { state.lastError = safeError(error); });
  });
  client.on("message",(topic,payload,packet) => {
    // MQTT.js only invokes customHandleAcks for QoS 1/2. A QoS 0 publish is
    // still durably audited, but cannot satisfy ACK-after-commit and is exposed
    // as a source-contract conflict in status/evidence.
    if (packet.qos !== 0 || !isTopic(topic) || !state.sessionId) return;
    void repository.accept(state.sessionId,topic,payload,packet,new Date().toISOString()).then((accepted) => {
      increment(state.messages,topic); if (accepted.validationState !== "VALID") increment(state.invalid,topic);
      increment(state.sourceQosConflicts,topic);
      state.lastError = `BLOCKED_SOURCE_CONTRACT_CONFLICT: ${topic} arrived at QoS 0`;
    }).catch((error) => { state.lastError = safeError(error); });
  });
  client.on("close",() => { state.connected = false; state.subscriptions = {}; });
  client.on("error",(error) => { state.lastError = safeError(error); });
}

async function processOne(repository: UgvIngestRepository,config: MapperConfig,state: RuntimeState): Promise<void> {
  try {
    const pending = await repository.nextPending(); if (!pending) return;
    try { await repository.storeMapping(pending,mapUgvMessage(pending,config),config.mapperVersion); }
    catch (error) { await repository.failMapping(pending.messageId,error); }
  } catch (error) { state.workerHealthy = false; state.lastError = safeError(error); }
}

async function deliverOne(repository: UgvIngestRepository,config: UgvIngestConfig,state: RuntimeState): Promise<void> {
  try {
    const item = await repository.nextOutbox(); if (!item) return;
    const path = item.kind === "OBSERVATION" ? "/observations" : "/operational-events";
    try {
      const response = await fetch(`${config.observationApiUrl.replace(/\/$/u,"")}${path}`,{
        method: "POST",headers: { "content-type": "application/json",...(item.kind === "OPERATIONAL_EVENT" ? { "x-data-scope-key": config.dataScopeKey } : {}) },
        body: item.bodyBytes,signal: AbortSignal.timeout(5000)
      });
      const delivered = response.status === 202 || response.status === 200;
      const permanent = response.status === 409 || response.status === 422;
      await repository.deliveryResult(item.outboxId,{ delivered,permanent,status: response.status,attempts: item.attempts,
        ...(delivered ? {} : { error: `HTTP_${response.status}` }) });
      if (delivered) state.lastApiSuccessAt = new Date().toISOString();
    } catch (error) { await repository.deliveryResult(item.outboxId,{ attempts: item.attempts,error: safeError(error) }); }
    state.workerHealthy = true;
  } catch (error) { state.workerHealthy = false; state.lastError = safeError(error); }
}

function mapperConfig(config: UgvIngestConfig): MapperConfig { return { ...config,mapperVersion: "ugv-mqtt-canonical-v1" }; }
function isTopic(value: string): value is UgvAuthorityTopic { return (UGV_AUTHORITY_TOPICS as readonly string[]).includes(value); }
function increment(record: Record<string,number>,key: string): void { record[key] = (record[key] ?? 0) + 1; }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0,2048); }
async function writable(pool: pg.Pool): Promise<boolean> { try { await pool.query("SELECT 1"); return true; } catch { return false; } }
function metrics(state: RuntimeState,status: Record<string,unknown>): string {
  const lines = [`mqtt_connected ${state.connected ? 1 : 0}`,`mqtt_session_present ${state.sessionPresent ? 1 : 0}`,
    `inbox_pending ${Number(status.inbox_pending ?? 0)}`,`inbox_dead_letter ${Number(status.inbox_dead_letter ?? 0)}`,
    `outbox_pending ${Number(status.outbox_pending ?? 0)}`];
  for (const topic of UGV_AUTHORITY_TOPICS) {
    lines.push(`mqtt_messages_total{topic=${JSON.stringify(topic)}} ${state.messages[topic] ?? 0}`,
      `mqtt_redeliveries_total{topic=${JSON.stringify(topic)}} ${state.redeliveries[topic] ?? 0}`,
      `mqtt_invalid_total{topic=${JSON.stringify(topic)}} ${state.invalid[topic] ?? 0}`);
    lines.push(`mqtt_source_qos_conflicts_total{topic=${JSON.stringify(topic)}} ${state.sourceQosConflicts[topic] ?? 0}`);
  }
  return `${lines.join("\n")}\n`;
}
