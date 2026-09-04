import Fastify, { type FastifyInstance } from "fastify";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import pg from "pg";
import { loadSourceSchemaLock, UGV_AUTHORITY_TOPICS, type UgvAuthorityTopic } from "../../../packages/integrations/ugv-mqtt-ingest-core/src/contracts.js";
import { mapUgvMessage, type MapperConfig } from "../../../packages/integrations/ugv-mqtt-ingest-core/src/mapper.js";
import { SourceSchemaRegistry } from "../../../packages/integrations/ugv-mqtt-ingest-core/src/source-schema-registry.js";
import { loadUgvIngestConfig, type UgvIngestConfig } from "./config.js";
import { UgvIngestRepository } from "./repository.js";

interface RuntimeState {
  connected: boolean; sessionPresent: boolean; sessionId?: string; subscriptions: Record<string,number>;
  sourceLockLoaded: boolean; workerHealthy: boolean; lastApiSuccessAt?: string; lastError?: string;
  messages: Record<string,number>; redeliveries: Record<string,number>; invalid: Record<string,number>;
  sourceQosConflicts: Record<string,number>; sessionLostTotal: number; retainedSkipped: Record<string,number>;
  samplingSuppressed: Record<string,number>; canonicalObservations: Record<string,number>;
  operationalEvents: Record<string,number>; outboxDelivery: Record<string,number>; topicLastAt: Record<string,number>;
}

export async function buildUgvMqttIngestApp(): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const config = await loadUgvIngestConfig();
  const schemaDirectory = process.env.UGV_EQUIPMENT_SCHEMA_DIR;
  if (!schemaDirectory) throw new Error("UGV_EQUIPMENT_SCHEMA_DIR is required");
  let sourceLock: Awaited<ReturnType<typeof loadSourceSchemaLock>> | undefined;
  let sourceLockError: string | undefined;
  try { sourceLock = await loadSourceSchemaLock(schemaDirectory); }
  catch (error) { sourceLockError = safeError(error); }
  const pool = new pg.Pool({ connectionString: config.databaseUrl,
    max: Math.max(8,Math.min(64,config.processConcurrency+config.deliveryConcurrency)) });
  await pool.query("SELECT 1");
  const repository = new UgvIngestRepository(pool,config.deviceId,config.maxPayloadBytes,config.maximumPendingInbox,
    sourceLock ? new SourceSchemaRegistry(sourceLock) : undefined);
  const state: RuntimeState = { connected: false,sessionPresent: false,subscriptions: {},sourceLockLoaded: Boolean(sourceLock),
    workerHealthy: true,messages: {},redeliveries: {},invalid: {},sourceQosConflicts: {},sessionLostTotal: 0,
    retainedSkipped: {},samplingSuppressed: {},canonicalObservations: {},operationalEvents: {},outboxDelivery: {},topicLastAt: {},
    ...(sourceLockError ? { lastError: sourceLockError } : {}) };
  let sessionId: string | undefined;
  let client: MqttClient | undefined;
  let connectionGeneration = 0;
  let sessionGate: {
    generation: number;
    promise: Promise<string | undefined>;
    resolve: (sessionId: string | undefined) => void;
  } = { generation: 0,promise: Promise.resolve(undefined),resolve: () => undefined };
  const beginSession = (): number => {
    const generation = ++connectionGeneration;
    let resolve!: (value: string | undefined) => void;
    const promise = new Promise<string | undefined>((resolver) => { resolve = resolver; });
    sessionId = undefined;
    delete state.sessionId;
    sessionGate = { generation,promise,resolve };
    return generation;
  };
  const waitForSession = (): Promise<string | undefined> => sessionId ? Promise.resolve(sessionId) : sessionGate.promise;
  const setSession = (generation: number,value: string): boolean => {
    if (sessionGate.generation !== generation || !state.connected) return false;
    sessionId = value;
    state.sessionId = value;
    sessionGate.resolve(value);
    return true;
  };
  const clearSession = (): void => {
    sessionId = undefined;
    delete state.sessionId;
    sessionGate.resolve(undefined);
    sessionGate = { generation: sessionGate.generation,promise: Promise.resolve(undefined),resolve: () => undefined };
  };
  const isCurrentConnection = (generation: number): boolean => sessionGate.generation === generation && state.connected;
  const pendingPubacks = new Map<number,number[]>();
  let durableInboxCommits = 0;
  if (sourceLock) {
    // MQTT.js can deliver a queued persistent-session PUBLISH while processing
    // CONNACK, before its public `connect` event fires. Arm the session gate
    // before opening the socket so customHandleAcks waits for the durable DB
    // session instead of observing the initial resolved-empty placeholder.
    beginSession();
    const options: IClientOptions = {
      protocolVersion: 5,clean: false,clientId: config.clientId,keepalive: config.keepaliveSeconds,
      connectTimeout: config.connectTimeoutMs,reconnectPeriod: 1000,resubscribe: false,manualConnect: true,
      properties: { sessionExpiryInterval: config.sessionExpirySeconds,receiveMaximum: config.receiveMaximum },
      ...(config.username ? { username: config.username } : {}),...(config.password ? { password: config.password } : {}),
      ...(config.ca ? { ca: config.ca } : {}),...(config.cert ? { cert: config.cert } : {}),...(config.key ? { key: config.key } : {}),
      customHandleAcks: (topic,payload,packet,done) => {
        if (!isTopic(topic)) return done(135);
        const receivedAt = new Date().toISOString();
        void waitForSession().then((activeSessionId) => {
          if (!activeSessionId) throw new Error("MQTT connection closed before durable session initialization");
          return repository.accept(activeSessionId,topic,payload,packet,receivedAt);
        }).then((accepted) => {
          increment(state.messages,topic); if (accepted.redelivery) increment(state.redeliveries,topic);
          if (accepted.validationState !== "VALID") increment(state.invalid,`${topic}:${accepted.validationState}`);
          state.topicLastAt[topic] = Date.now();
          durableInboxCommits += 1;
          if (config.faultExitAfterInboxCommits === durableInboxCommits) {
            process.kill(process.pid,"SIGKILL");
            return;
          }
          if (packet.messageId !== undefined && accepted.packetGeneration !== undefined) {
            const generations = pendingPubacks.get(packet.messageId) ?? [];
            generations.push(accepted.packetGeneration);
            pendingPubacks.set(packet.messageId,generations);
          }
          done(0);
        }).catch((error) => {
          state.lastError = safeError(error);
          done(error instanceof Error ? error : new Error(String(error)));
          queueMicrotask(() => client?.end(true));
        });
      }
    };
    client = mqtt.connect(config.mqttUrl,options);
    wireClient(client,config,sourceLock,repository,state,pendingPubacks,
      beginSession,() => sessionGate.generation,setSession,clearSession,isCurrentConnection,waitForSession);
    client.connect();
  }

  let processing = false; let delivering = false;
  const processTimer = setInterval(() => {
    if (processing) return;
    processing = true;
    void Promise.all(Array.from({ length: config.processConcurrency },() =>
      processOne(repository,config.clientId,new URL(config.mqttUrl).host,state))).finally(() => { processing = false; });
  },25);
  const deliveryTimer = setInterval(() => {
    if (delivering) return;
    delivering = true;
    void Promise.all(Array.from({ length: config.deliveryConcurrency },() =>
      deliverOne(repository,config,state))).finally(() => { delivering = false; });
  },50);
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
    sourceSchemaLock: sourceLock ? { lockVersion: sourceLock.lockVersion,files: sourceLock.files,
      topicSchemaHash: sourceLock.topicSchemaHash,validatedTopics: sourceLock.validatedTopics } : null,
    lastApiSuccessAt: state.lastApiSuccessAt,lastError: state.lastError ?? null }));
  app.get("/metrics",async (_request,reply) => reply.type("text/plain; version=0.0.4").send(metrics(state,await repository.status())));
  return { app,close: async () => {
    clearInterval(processTimer); clearInterval(deliveryTimer);
    if (sessionId) await repository.disconnect(sessionId,"graceful_shutdown").catch(() => undefined);
    if (client) await new Promise<void>((resolve,reject) => client.end(false,{},(error) => error ? reject(error) : resolve()));
    await pool.end(); await app.close();
  } };
}

function wireClient(client: MqttClient,config: UgvIngestConfig,sourceLock: Awaited<ReturnType<typeof loadSourceSchemaLock>>,
  repository: UgvIngestRepository,state: RuntimeState,pendingPubacks: Map<number,number[]>,beginSession: () => number,
  currentSessionGeneration: () => number,
  setSession: (generation: number,id: string) => boolean,clearSession: () => void,
  isCurrentConnection: (generation: number) => boolean,waitForSession: () => Promise<string | undefined>): void {
  client.on("reconnect",() => { beginSession(); });
  // A resumed broker session may send queued PUBLISH packets before MQTT.js
  // emits its public `connect` event. packetreceive(CONNACK) is the earliest
  // ordered point where sessionPresent is known, so durable session creation
  // must begin here to avoid a connect/PUBLISH acknowledgement deadlock.
  client.on("packetreceive",(packet) => {
    if (packet.cmd !== "connack") return;
    state.connected = true;
    state.sessionPresent = packet.sessionPresent;
    const connectionGeneration = currentSessionGeneration();
    void (async () => {
      const session = await repository.startSession(config.clientId,new URL(config.mqttUrl).host,packet.sessionPresent,
        sourceLock,config.codeVersion,mapperConfig(config));
      if (!setSession(connectionGeneration,session.sessionId)) {
        await repository.disconnect(session.sessionId,"mqtt_connection_closed_during_session_initialization");
        return;
      }
      if (session.sessionLost) { state.sessionLostTotal += 1; state.lastError = "MQTT_SESSION_LOST"; }
    })().catch((error) => {
      if (!isCurrentConnection(connectionGeneration)) return;
      state.lastError = safeError(error);
      client.end(true);
    });
  });
  client.on("connect",() => {
    const connectionGeneration = currentSessionGeneration();
    void (async () => {
      const activeSessionId = await waitForSession();
      if (!activeSessionId || !isCurrentConnection(connectionGeneration)) return;
      const requests = Object.fromEntries(UGV_AUTHORITY_TOPICS.map((topic) => [topic,{ qos: 1 as const }]));
      const grants = await client.subscribeAsync(requests);
      if (!isCurrentConnection(connectionGeneration)) return;
      state.subscriptions = Object.fromEntries(grants.map((grant) => [grant.topic,grant.qos]));
      await repository.setSubscriptions(activeSessionId,state.subscriptions);
    })().catch((error) => {
      if (!isCurrentConnection(connectionGeneration)) return;
      state.lastError = safeError(error);
      client.end(true);
    });
  });
  client.on("packetsend",(packet) => {
    if (packet.cmd !== "puback" || !state.sessionId || packet.messageId === undefined) return;
    const generations = pendingPubacks.get(packet.messageId);
    const generation = generations?.shift();
    if (!generations?.length) pendingPubacks.delete(packet.messageId);
    if (generation === undefined) {
      state.lastError = "PUBACK_SENT_WITHOUT_DURABLE_PACKET_GENERATION";
      client.end(true);
      return;
    }
    void repository.markPuback(state.sessionId,packet.messageId,generation).catch((error) => {
      state.lastError = safeError(error); client.end(true);
    });
  });
  client.on("message",(topic,payload,packet) => {
    // MQTT.js only invokes customHandleAcks for QoS 1/2. A QoS 0 publish is
    // still durably audited, but cannot satisfy ACK-after-commit and is exposed
    // as a source-contract conflict in status/evidence.
    if (packet.qos !== 0 || !isTopic(topic)) return;
    const receivedAt = new Date().toISOString();
    void waitForSession().then((activeSessionId) => {
      if (!activeSessionId) throw new Error("MQTT connection closed before durable session initialization");
      return repository.accept(activeSessionId,topic,payload,packet,receivedAt);
    }).then((accepted) => {
      increment(state.messages,topic); if (accepted.validationState !== "VALID") increment(state.invalid,`${topic}:${accepted.validationState}`);
      state.topicLastAt[topic] = Date.now();
      increment(state.sourceQosConflicts,topic);
      state.lastError = `BLOCKED_SOURCE_CONTRACT_CONFLICT: ${topic} arrived at QoS 0`;
    }).catch((error) => { state.lastError = safeError(error); client.end(true); });
  });
  client.on("close",() => {
    state.connected = false;
    state.subscriptions = {};
    pendingPubacks.clear();
    clearSession();
  });
  client.on("error",(error) => { state.lastError = safeError(error); });
}

async function processOne(repository: UgvIngestRepository,clientId: string,brokerId: string,state: RuntimeState): Promise<void> {
  try {
    const pending = await repository.nextPending(clientId,brokerId);
    if (!pending) { state.workerHealthy = true; return; }
    try {
      const mapping = mapUgvMessage(pending,pending.mapperConfig);
      await repository.storeMapping(pending,mapping,pending.mapperConfig.mapperVersion);
      if (mapping.ignoredReason) {
        increment(state.samplingSuppressed,`${pending.topic}:${mapping.ignoredReason}`);
        if (mapping.ignoredReason === "RETAINED_POSITION_SKIPPED") increment(state.retainedSkipped,pending.topic);
      }
      for (const observation of mapping.observations) increment(state.canonicalObservations,observation.observationType);
      for (const event of mapping.events) increment(state.operationalEvents,event.eventType);
    }
    catch (error) { await repository.failMapping(pending.messageId,error); }
    state.workerHealthy = true;
  } catch (error) { state.workerHealthy = false; state.lastError = safeError(error); }
}

async function deliverOne(repository: UgvIngestRepository,config: UgvIngestConfig,state: RuntimeState): Promise<void> {
  try {
    const item = await repository.nextOutbox();
    if (!item) { state.workerHealthy = true; return; }
    const path = item.kind === "OBSERVATION" ? "/observations" : "/operational-events";
    try {
      const response = await fetch(`${config.observationApiUrl.replace(/\/$/u,"")}${path}`,{
        method: "POST",headers: item.headers,
        body: item.bodyBytes,signal: AbortSignal.timeout(config.httpTimeoutMs)
      });
      const delivered = response.status === 202 || response.status === 200;
      if (delivered) state.lastApiSuccessAt = new Date().toISOString();
      const permanent = response.status >= 400 && response.status < 500 && ![408,425,429].includes(response.status);
      await repository.deliveryResult(item.outboxId,{ delivered,permanent,status: response.status,attempts: item.attempts,
        ...(delivered ? {} : { error: `HTTP_${response.status}` }) });
      increment(state.outboxDelivery,`${item.kind}:${delivered ? "delivered" : permanent ? "permanent_failure" : "retry"}`);
    } catch (error) {
      await repository.deliveryResult(item.outboxId,{ attempts: item.attempts,error: safeError(error) });
      increment(state.outboxDelivery,`${item.kind}:retry`);
    }
    state.workerHealthy = true;
  } catch (error) { state.workerHealthy = false; state.lastError = safeError(error); }
}

function mapperConfig(config: UgvIngestConfig): MapperConfig {
  return {
    deviceId: config.deviceId,
    dataScopeKey: config.dataScopeKey,
    sourceKey: config.sourceKey,
    producerPipelineKey: config.producerPipelineKey,
    scenarioId: config.scenarioId,
    worldEpoch: config.worldEpoch,
    trackerSessionKey: config.trackerSessionKey,
    analysisSpaceKey: config.analysisSpaceKey,
    analysisSrid: config.analysisSrid,
    arrivalUncertaintyMs: config.arrivalUncertaintyMs,
    mapperVersion: "ugv-mqtt-canonical-v1",
    samplingPolicy: config.samplingPolicy,
    maxTargetsPerFrame: config.maxTargetsPerFrame
  };
}
function isTopic(value: string): value is UgvAuthorityTopic { return (UGV_AUTHORITY_TOPICS as readonly string[]).includes(value); }
function increment(record: Record<string,number>,key: string): void { record[key] = (record[key] ?? 0) + 1; }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0,2048); }
async function writable(pool: pg.Pool): Promise<boolean> { try { await pool.query("SELECT 1"); return true; } catch { return false; } }
function metrics(state: RuntimeState,status: Record<string,unknown>): string {
  const lines = [`mqtt_connected ${state.connected ? 1 : 0}`,`mqtt_session_present ${state.sessionPresent ? 1 : 0}`,
    `mqtt_session_lost_total ${state.sessionLostTotal}`,`mqtt_persisted_redeliveries_total ${Number(status.persisted_redelivery_count ?? 0)}`,
    `inbox_pending ${Number(status.inbox_pending ?? 0)}`,`inbox_dead_letter ${Number(status.inbox_dead_letter ?? 0)}`,
    `outbox_pending{kind="OBSERVATION"} ${Number(status.outbox_pending_observation ?? 0)}`,
    `outbox_pending{kind="OPERATIONAL_EVENT"} ${Number(status.outbox_pending_operational_event ?? 0)}`,
    `outbox_oldest_age_seconds ${Number(status.outbox_oldest_age_seconds ?? 0)}`];
  for (const topic of UGV_AUTHORITY_TOPICS) {
    lines.push(`mqtt_messages_total{topic=${JSON.stringify(topic)}} ${state.messages[topic] ?? 0}`,
      `mqtt_redeliveries_total{topic=${JSON.stringify(topic)}} ${state.redeliveries[topic] ?? 0}`,
      `mqtt_retained_skipped_total{topic=${JSON.stringify(topic)}} ${state.retainedSkipped[topic] ?? 0}`,
      `mqtt_source_qos_conflicts_total{topic=${JSON.stringify(topic)}} ${state.sourceQosConflicts[topic] ?? 0}`,
      `topic_last_message_age_seconds{topic=${JSON.stringify(topic)}} ${state.topicLastAt[topic] ? Math.max(0,(Date.now()-state.topicLastAt[topic])/1000) : -1}`);
    for (const [key,count] of Object.entries(state.invalid)) {
      const prefix = `${topic}:`; if (key.startsWith(prefix)) lines.push(`mqtt_invalid_total{topic=${JSON.stringify(topic)},reason=${JSON.stringify(key.slice(prefix.length))}} ${count}`);
    }
  }
  for (const [key,count] of Object.entries(state.outboxDelivery)) {
    const [kind,statusLabel] = key.split(":");
    lines.push(`outbox_delivery_total{kind=${JSON.stringify(kind)},status=${JSON.stringify(statusLabel)}} ${count}`);
  }
  for (const [type,count] of Object.entries(state.canonicalObservations)) lines.push(`canonical_observations_total{type=${JSON.stringify(type)}} ${count}`);
  for (const [type,count] of Object.entries(state.operationalEvents)) lines.push(`operational_events_total{type=${JSON.stringify(type)}} ${count}`);
  for (const [key,count] of Object.entries(state.samplingSuppressed)) {
    const separator = key.lastIndexOf(":"); const topic = key.slice(0,separator); const reason = key.slice(separator+1);
    lines.push(`sampling_suppressed_total{topic=${JSON.stringify(topic)},reason=${JSON.stringify(reason)}} ${count}`);
  }
  return `${lines.join("\n")}\n`;
}
