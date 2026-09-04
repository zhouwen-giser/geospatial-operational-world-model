import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import mqtt from "mqtt";
import pg from "pg";

const databaseUrl = required("UGV_MQTT_TEST_DATABASE_URL");
const brokerUrl = required("UGV_MQTT_FIXTURE_BROKER_URL");
const schemaDirectory = required("UGV_EQUIPMENT_SCHEMA_DIR");
const observationApiUrl = required("GOWM_OBSERVATION_API_URL").replace(/\/$/u,"");
const port = positiveInteger("UGV_MQTT_RELIABILITY_PORT",23117);
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/^gowm_ugv_ingest_acceptance_[a-z0-9_]+$/u.test(databaseName)) {
  throw new Error("reliability e2e requires a disposable gowm_ugv_ingest_acceptance_* database");
}
const broker = new URL(brokerUrl);
if (!["mqtt:","mqtts:","ws:","wss:"].includes(broker.protocol) || broker.username || broker.password) {
  throw new Error("fixture broker URL must use MQTT without embedded credentials");
}
const observationHealth = await fetch(`${observationApiUrl}/health`,{ signal: AbortSignal.timeout(5_000) });
if (!observationHealth.ok) throw new Error(`Observation Ingest health returned HTTP ${observationHealth.status}`);

const runKey = `${Date.now()}-${randomUUID().slice(0,8)}`;
const crashClientId = `gowm-ugv-crash-${runKey}`;
const retainedClientId = `gowm-ugv-retained-${runKey}`;
const pool = new pg.Pool({ connectionString: databaseUrl,max: 2 });
const children = new Set<ManagedChild>();
let retainedFixtureCreated = false;

try {
  const faulted = startIngest(crashClientId,`crash-${runKey}`,true);
  children.add(faulted);
  await waitReady(faulted);
  await publish("/ugv/gnss",{
    latitude: 29.71961,longitude: 106.81496,altitude: 501.2
  });
  const faultExit = await withTimeout(faulted.exited,10_000,"fault-injected consumer did not terminate");
  children.delete(faulted);
  if (faultExit.signal !== "SIGKILL") {
    throw new Error(`fault-injected consumer exited unexpectedly: ${JSON.stringify(faultExit)}\n${faulted.logs()}`);
  }
  const committedBeforeAck = await pool.query<{
    inbox_count: number; received_count: number; redeliveries: string; puback_missing: boolean;
  }>(`SELECT count(DISTINCT i.message_id)::int AS inbox_count,
            count(DISTINCT i.message_id) FILTER (WHERE i.processing_state='RECEIVED')::int AS received_count,
            COALESCE(sum(DISTINCT i.redelivery_count),0)::text AS redeliveries,
            bool_and(p.puback_sent_at IS NULL) AS puback_missing
       FROM ugv_ingest.inbox_message i
       JOIN ugv_ingest.mqtt_session s USING(session_id)
       LEFT JOIN ugv_ingest.packet_slot p ON p.message_id=i.message_id
      WHERE s.client_id=$1`,[crashClientId]);
  const before = committedBeforeAck.rows[0];
  if (before?.inbox_count !== 1 || before.received_count !== 1 || before.redeliveries !== "0" || before.puback_missing !== true) {
    throw new Error(`durable-commit-before-PUBACK invariant failed: ${JSON.stringify(before ?? {})}`);
  }

  const recovered = startIngest(crashClientId,`crash-${runKey}`,false);
  children.add(recovered);
  await waitReady(recovered);
  const recovery = await waitFor(async () => {
    const result = await pool.query<{
      inbox_count: number; redeliveries: string; puback_recorded: boolean; outbox_keys: number;
      delivered: number; canonical_rows: number; dead_letters: number;
    }>(`SELECT count(DISTINCT i.message_id)::int AS inbox_count,
              COALESCE(sum(DISTINCT i.redelivery_count),0)::text AS redeliveries,
              bool_and(p.puback_sent_at IS NOT NULL) AS puback_recorded,
              count(DISTINCT o.idempotency_key)::int AS outbox_keys,
              count(DISTINCT o.outbox_id) FILTER (WHERE o.delivery_state='DELIVERED')::int AS delivered,
              count(DISTINCT observation.observation_id)::int AS canonical_rows,
              count(DISTINCT i.message_id) FILTER (WHERE i.processing_state='DEAD_LETTER')::int AS dead_letters
         FROM ugv_ingest.inbox_message i
         JOIN ugv_ingest.mqtt_session s USING(session_id)
         LEFT JOIN ugv_ingest.packet_slot p ON p.message_id=i.message_id
         LEFT JOIN ugv_ingest.outbox_message o ON o.inbox_message_id=i.message_id
         LEFT JOIN world_observation observation ON observation.observation_id=o.idempotency_key
        WHERE s.client_id=$1`,[crashClientId]);
    const row = result.rows[0];
    return row?.inbox_count === 1 && Number(row.redeliveries) >= 1 && row.puback_recorded === true &&
      row.outbox_keys === 1 && row.delivered === 1 && row.canonical_rows === 1 && row.dead_letters === 0 ? row : undefined;
  },15_000,"persistent-session redelivery did not converge to one delivered Canonical observation");
  await stop(recovered);
  children.delete(recovered);

  await publish("/ugv/gnss",{
    latitude: 29.71971,longitude: 106.81506,altitude: 502.3
  },true);
  retainedFixtureCreated = true;
  const retainedConsumer = startIngest(retainedClientId,`retained-${runKey}`,false);
  children.add(retainedConsumer);
  await waitReady(retainedConsumer);
  const retained = await waitFor(async () => {
    const result = await pool.query<{
      inbox_count: number; all_retained: boolean; all_ignored: boolean; outbox_count: number;
    }>(`SELECT count(DISTINCT i.message_id)::int AS inbox_count,
              bool_and(i.retained_flag) AS all_retained,
              bool_and(i.processing_state='IGNORED_BY_POLICY') AS all_ignored,
              count(DISTINCT o.outbox_id)::int AS outbox_count
         FROM ugv_ingest.inbox_message i
         JOIN ugv_ingest.mqtt_session s USING(session_id)
         LEFT JOIN ugv_ingest.outbox_message o ON o.inbox_message_id=i.message_id
        WHERE s.client_id=$1 AND i.topic='/ugv/gnss'`,[retainedClientId]);
    const row = result.rows[0];
    return row?.inbox_count === 1 && row.all_retained === true && row.all_ignored === true && row.outbox_count === 0
      ? row : undefined;
  },10_000,"retained GNSS was not durably ignored by policy");
  await stop(retainedConsumer);
  children.delete(retainedConsumer);

  process.stdout.write(`${JSON.stringify({
    status: "PASS_CONSUMER_RELIABILITY_NOT_SOURCE_ACCEPTANCE",
    marker: "UGV_MQTT_ACK_CRASH_AND_RETAINED_POLICY",
    crashWindow: { before,recovery },
    retainedPosition: retained,
    sourceContractAuthority: "NOT_ASSERTED"
  })}\n`);
} finally {
  for (const child of children) await stop(child).catch(() => undefined);
  if (retainedFixtureCreated) await publish("/ugv/gnss",Buffer.alloc(0),true).catch(() => undefined);
  await pool.end();
}

interface ManagedChild {
  process: ChildProcessWithoutNullStreams;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  result?: { code: number | null; signal: NodeJS.Signals | null };
  logs: () => string;
}

function startIngest(clientId: string,worldEpoch: string,fault: boolean): ManagedChild {
  const child = spawn(process.execPath,["--import","tsx","services/ugv-mqtt-ingest/src/index.ts"],{
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      UGV_MQTT_URL: brokerUrl,
      UGV_EQUIPMENT_SCHEMA_DIR: schemaDirectory,
      UGV_MQTT_CLIENT_ID: clientId,
      UGV_WORLD_EPOCH: worldEpoch,
      UGV_TRACKER_SESSION_KEY: `${worldEpoch}:ugv`,
      UGV_MQTT_INGEST_PORT: String(port),
      GOWM_OBSERVATION_API_URL: observationApiUrl,
      UGV_ANALYSIS_SPACE_KEY: process.env.UGV_ANALYSIS_SPACE_KEY ?? "airport-utm48n",
      UGV_ANALYSIS_SRID: process.env.UGV_ANALYSIS_SRID ?? "32648",
      UGV_MQTT_FAULT_EXIT_AFTER_INBOX_COMMITS: fault ? "1" : "",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn"
    },
    stdio: ["ignore","pipe","pipe"]
  });
  let output = "";
  const append = (chunk: Buffer): void => { output = `${output}${chunk.toString("utf8")}`.slice(-65_536); };
  child.stdout.on("data",append);
  child.stderr.on("data",append);
  const managed: ManagedChild = {
    process: child,
    exited: Promise.resolve({ code: null,signal: null }),
    logs: () => output
  };
  managed.exited = new Promise((resolve) => child.once("exit",(code,signal) => {
    managed.result = { code,signal };
    resolve(managed.result);
  }));
  return managed;
}

async function waitReady(child: ManagedChild): Promise<void> {
  let lastReadiness = "unavailable";
  try {
    await waitFor(async () => {
      if (child.result) throw new Error(`consumer exited before readiness: ${JSON.stringify(child.result)}\n${child.logs()}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health/ready`,{ signal: AbortSignal.timeout(1_000) });
        const text = await response.text();
        lastReadiness = `HTTP ${response.status} ${text}`;
        if (!response.ok) return undefined;
        const body = JSON.parse(text) as { ready?: unknown };
        return body.ready === true ? true : undefined;
      } catch { return undefined; }
    },15_000,"consumer did not become ready");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nlast readiness: ${lastReadiness}\nconsumer logs:\n${child.logs()}`);
  }
}

async function stop(child: ManagedChild): Promise<void> {
  if (child.result) return;
  child.process.kill("SIGTERM");
  try { await withTimeout(child.exited,5_000,"consumer did not stop on SIGTERM"); }
  catch (error) {
    child.process.kill("SIGKILL");
    await child.exited;
    throw error;
  }
}

async function publish(topic: string,payload: unknown,retain = false): Promise<void> {
  const client = await mqtt.connectAsync(brokerUrl,{
    protocolVersion: 5,clean: true,clientId: `gowm-ugv-reliability-publisher-${randomUUID()}`,reconnectPeriod: 0
  });
  try {
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload),"utf8");
    await client.publishAsync(topic,bytes,{ qos: 1,retain });
  } finally { await client.endAsync(); }
}

async function waitFor<T>(probe: () => Promise<T | undefined>,timeoutMs: number,message: string): Promise<T> {
  const deadline = Date.now()+timeoutMs;
  while (Date.now()<deadline) {
    const result = await probe();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve,100));
  }
  throw new Error(message);
}

async function withTimeout<T>(promise: Promise<T>,timeoutMs: number,message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve,reject) => { timer = setTimeout(() => reject(new Error(message)),timeoutMs); })
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string,fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value<=0 || value>65_535) throw new Error(`${name} must be a valid TCP port`);
  return value;
}
