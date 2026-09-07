import { execFileSync } from "node:child_process";
import { readFile,writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import mqtt from "mqtt";
import pg from "pg";
import { UGV_AUTHORITY_TOPICS, type UgvAuthorityTopic } from "../../packages/integrations/ugv-mqtt-ingest-core/src/contracts.js";

const databaseUrl = required("UGV_MQTT_TEST_DATABASE_URL");
const brokerUrl = required("UGV_MQTT_FIXTURE_BROKER_URL");
const readinessUrl = required("UGV_MQTT_INGEST_READY_URL");
const clientId = required("UGV_MQTT_PERFORMANCE_CLIENT_ID");
const outputPath = required("UGV_MQTT_PERFORMANCE_OUTPUT");
const servicePid = positiveInteger("UGV_MQTT_PERFORMANCE_PROCESS_PID");
const durationSeconds = positiveInteger("UGV_MQTT_PERFORMANCE_DURATION_SECONDS",600);
const rate = positiveInteger("UGV_MQTT_PERFORMANCE_RATE",110);
if (durationSeconds < 600) throw new Error("performance run must last at least 600 seconds");
if (rate < 100) throw new Error("performance run must publish at least 100 messages per second");
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/^gowm_ugv_ingest_acceptance_[a-z0-9_]+$/u.test(databaseName)) {
  throw new Error("performance run requires a disposable gowm_ugv_ingest_acceptance_* database");
}
const broker = new URL(brokerUrl);
if (!['mqtt:','mqtts:','ws:','wss:'].includes(broker.protocol) || broker.username || broker.password) {
  throw new Error("performance broker URL must not embed credentials");
}
const processCommand = (await readFile(`/proc/${servicePid}/cmdline`)).toString("utf8").replaceAll("\0"," ");
if (!processCommand.includes("services/ugv-mqtt-ingest/src/index.ts")) {
  throw new Error("UGV_MQTT_PERFORMANCE_PROCESS_PID is not the UGV ingest process");
}
await assertReady();

const pool = new pg.Pool({ connectionString: databaseUrl,max: 2 });
const baseline = await scopedCounts(pool,clientId);
if (baseline.inbox !== 0 || baseline.outbox !== 0) throw new Error("performance client must have an empty baseline");
const clockTicks = Number(execFileSync("getconf",["CLK_TCK"],{ encoding: "utf8" }).trim());
const metrics: RuntimeSample[] = [];
let monitoring = true;
let maximumBacklog = 0;
const monitor = (async () => {
  while (monitoring) {
    const [processSample,counts] = await Promise.all([sampleProcess(servicePid,clockTicks),scopedCounts(pool,clientId)]);
    const backlog = counts.pendingInbox+counts.pendingOutbox;
    maximumBacklog = Math.max(maximumBacklog,backlog);
    metrics.push({ elapsedSeconds: 0,...processSample,backlog });
    await delay(1000);
  }
})();

const publisher = await mqtt.connectAsync(broker.toString(),{
  protocolVersion: 5,clean: true,clientId: `gowm-ugv-performance-publisher-${process.pid}`,reconnectPeriod: 0
});
const startedAt = new Date().toISOString();
const start = performance.now();
const slotsPerSecond = 10;
const messagesPerSlot = Math.ceil(rate/slotsPerSecond);
const totalMessages = rate*durationSeconds;
let published = 0;
try {
  for (let slot=0; published<totalMessages; slot+=1) {
    const due = start+(slot*1000/slotsPerSecond);
    const remaining = due-performance.now();
    if (remaining>0) await delay(remaining);
    const batch = Math.min(messagesPerSlot,totalMessages-published);
    const publishes: Promise<unknown>[] = [];
    for (let offset=0; offset<batch; offset+=1) {
      const sequence = published+offset;
      const topic = UGV_AUTHORITY_TOPICS[sequence%UGV_AUTHORITY_TOPICS.length]!;
      publishes.push(publisher.publishAsync(topic,JSON.stringify(payload(topic,sequence)),{ qos: 1,retain: false }));
    }
    await Promise.all(publishes);
    published += batch;
  }
  const remainingRunTime = start+(durationSeconds*1000)-performance.now();
  if (remainingRunTime>0) await delay(remainingRunTime);
} finally {
  await publisher.endAsync();
}
const publishDurationSeconds = (performance.now()-start)/1000;
const drainStarted = performance.now();
let counts = await scopedCounts(pool,clientId);
while (counts.inbox<totalMessages || counts.pendingInbox>0 || counts.pendingOutbox>0) {
  if (performance.now()-drainStarted>300_000) throw new Error(`performance backlog did not drain: ${JSON.stringify(counts)}`);
  await delay(500);
  counts = await scopedCounts(pool,clientId);
}
const recoverySeconds = (performance.now()-drainStarted)/1000;
monitoring = false;
await monitor;
for (const sample of metrics) sample.elapsedSeconds = (sample.observedAtMs-metrics[0]!.observedAtMs)/1000;

const topicCounts = await pool.query<{ topic: string; count: number }>(
  `SELECT i.topic,count(*)::int AS count FROM ugv_ingest.inbox_message i
     JOIN ugv_ingest.mqtt_session s USING(session_id) WHERE s.client_id=$1 GROUP BY i.topic ORDER BY i.topic`,[clientId]
);
const latency = await pool.query<{
  inbox_p50_ms: number; inbox_p95_ms: number; inbox_p99_ms: number;
  outbox_p50_ms: number | null; outbox_p95_ms: number | null; outbox_p99_ms: number | null;
}>(`SELECT
    percentile_cont(0.50) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (i.created_at-i.adapter_received_at))*1000)::float8 AS inbox_p50_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (i.created_at-i.adapter_received_at))*1000)::float8 AS inbox_p95_ms,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (i.created_at-i.adapter_received_at))*1000)::float8 AS inbox_p99_ms,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (o.delivered_at-o.created_at))*1000) FILTER (WHERE o.delivered_at IS NOT NULL)::float8 AS outbox_p50_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (o.delivered_at-o.created_at))*1000) FILTER (WHERE o.delivered_at IS NOT NULL)::float8 AS outbox_p95_ms,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (o.delivered_at-o.created_at))*1000) FILTER (WHERE o.delivered_at IS NOT NULL)::float8 AS outbox_p99_ms
   FROM ugv_ingest.inbox_message i JOIN ugv_ingest.mqtt_session s USING(session_id)
   LEFT JOIN ugv_ingest.outbox_message o ON o.inbox_message_id=i.message_id WHERE s.client_id=$1`,[clientId]);
const cursorOrder = await pool.query<{ topic: string; max_inbox: string; cursor_sequence: string | null }>(
  `SELECT i.topic,max(i.ingest_sequence)::text AS max_inbox,max(c.last_inbox_sequence)::text AS cursor_sequence
     FROM ugv_ingest.inbox_message i JOIN ugv_ingest.mqtt_session s USING(session_id)
     LEFT JOIN ugv_ingest.stream_cursor c ON c.device_id=i.device_id AND c.topic=i.topic
       AND c.cursor_key='authority:'||s.mapper_context_hash
    WHERE s.client_id=$1 GROUP BY i.topic ORDER BY i.topic`,[clientId]
);
const indexUsage = await pool.query<{ indexrelname: string; idx_scan: string }>(
  `SELECT indexrelname,idx_scan::text FROM pg_stat_user_indexes WHERE schemaname='ugv_ingest' ORDER BY indexrelname`
);
const versions = await pool.query<{ postgresql: string; postgis: string; mobilitydb: string }>(
  `SELECT current_setting('server_version') AS postgresql,postgis_lib_version() AS postgis,mobilitydb_version() AS mobilitydb`
);
await pool.end();

const rssValues = metrics.map((sample) => sample.rssBytes);
const cpuStart = metrics[0]?.cpuSeconds ?? 0;
const cpuEnd = metrics.at(-1)?.cpuSeconds ?? cpuStart;
const midpoint = Math.floor(metrics.length/2);
const rssSlopeBytesPerMinute = linearSlope(metrics.slice(midpoint).map((sample) => [sample.elapsedSeconds,sample.rssBytes]))*60;
const actualRate = totalMessages/publishDurationSeconds;
const cursorOrdered = cursorOrder.rows.every((row) => row.cursor_sequence === row.max_inbox);
const indexScans = indexUsage.rows.filter((row) => Number(row.idx_scan)>0);
const errors = counts.deadInbox+counts.deadOutbox;
const status = actualRate>=100 && publishDurationSeconds>=600 && counts.inbox===totalMessages && errors===0 &&
  counts.pendingInbox===0 && counts.pendingOutbox===0 && cursorOrdered && indexScans.length>0 &&
  rssSlopeBytesPerMinute<=1_048_576 ? "PASS" : "FAIL";
const report = {
  status,marker: "UGV_MQTT_REAL_LOCAL_PERFORMANCE_NOT_SOURCE_ACCEPTANCE",startedAt,finishedAt: new Date().toISOString(),
  durationSeconds: publishDurationSeconds,rateMessagesPerSecond: actualRate,publishedMessages: totalMessages,
  durableInboxMessages: counts.inbox,topicCounts: Object.fromEntries(topicCounts.rows.map((row) => [row.topic,row.count])),
  latencyMs: latency.rows[0],maximumBacklog,recoverySeconds,
  process: { pid: servicePid,sampleCount: metrics.length,rssStartBytes: rssValues[0],rssMaximumBytes: Math.max(...rssValues),
    rssEndBytes: rssValues.at(-1),rssSlopeBytesPerMinuteSecondHalf: rssSlopeBytesPerMinute,cpuSeconds: cpuEnd-cpuStart },
  errors: { inboxDeadLetter: counts.deadInbox,outboxDeadLetter: counts.deadOutbox,total: errors },
  finalBacklog: { inbox: counts.pendingInbox,outbox: counts.pendingOutbox },cursorOrdered,
  indexScans,indexEnvironment: versions.rows[0],sourceContractAuthority: "NOT_ASSERTED"
};
await writeFile(outputPath,`${JSON.stringify(report,null,2)}\n`,{ encoding: "utf8",mode: 0o600 });
process.stdout.write(`${JSON.stringify(report)}\n`);
if (status !== "PASS") process.exitCode = 1;

interface RuntimeSample { observedAtMs: number; elapsedSeconds: number; rssBytes: number; cpuSeconds: number; backlog: number; }
async function sampleProcess(pid: number,ticksPerSecond: number): Promise<Omit<RuntimeSample,"elapsedSeconds"|"backlog">> {
  const [status,stat] = await Promise.all([readFile(`/proc/${pid}/status`,"utf8"),readFile(`/proc/${pid}/stat`,"utf8")]);
  const rssKiB = Number(/^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1] ?? NaN);
  const fields = stat.slice(stat.lastIndexOf(")")+2).trim().split(/\s+/u);
  const userTicks = Number(fields[11]); const systemTicks = Number(fields[12]);
  if (![rssKiB,userTicks,systemTicks].every(Number.isFinite)) throw new Error("could not sample UGV ingest process resources");
  return { observedAtMs: Date.now(),rssBytes: rssKiB*1024,cpuSeconds: (userTicks+systemTicks)/ticksPerSecond };
}
async function scopedCounts(pool: pg.Pool,id: string): Promise<{ inbox: number; outbox: number; pendingInbox: number; pendingOutbox: number; deadInbox: number; deadOutbox: number }> {
  const result = await pool.query(`SELECT count(DISTINCT i.message_id)::int AS inbox,
    count(DISTINCT o.outbox_id)::int AS outbox,
    count(DISTINCT i.message_id) FILTER (WHERE i.processing_state IN ('RECEIVED','VALIDATED','OUTBOXED'))::int AS pending_inbox,
    count(DISTINCT o.outbox_id) FILTER (WHERE o.delivery_state='PENDING')::int AS pending_outbox,
    count(DISTINCT i.message_id) FILTER (WHERE i.processing_state='DEAD_LETTER')::int AS dead_inbox,
    count(DISTINCT o.outbox_id) FILTER (WHERE o.delivery_state='DEAD_LETTER')::int AS dead_outbox
    FROM ugv_ingest.mqtt_session s LEFT JOIN ugv_ingest.inbox_message i USING(session_id)
    LEFT JOIN ugv_ingest.outbox_message o ON o.inbox_message_id=i.message_id WHERE s.client_id=$1`,[id]);
  const row = result.rows[0] as Record<string,number>;
  return { inbox: row.inbox ?? 0,outbox: row.outbox ?? 0,pendingInbox: row.pending_inbox ?? 0,pendingOutbox: row.pending_outbox ?? 0,
    deadInbox: row.dead_inbox ?? 0,deadOutbox: row.dead_outbox ?? 0 };
}
function payload(topic: UgvAuthorityTopic,sequence: number): Record<string,unknown> {
  switch (topic) {
    case "/ugv/gnss": return { latitude: 29.7195,longitude: 106.81485,altitude: 500,performanceSequence: sequence };
    case "/ugv/speed": return { data: 18,performanceSequence: sequence };
    case "status/ugv": return { available: true,ready_status: 1,performanceSequence: sequence };
    case "/ugv/mission_state": return { entity_id: "ugv",id: 9001,type: 1,state: 1,progress: 10,performanceSequence: sequence };
    case "/ugv/area_recon/status": return { status: 5,status_label: "RUNNING",progress: 10,coverage: 10,camera_fault: false,performanceSequence: sequence };
    case "/ugv/area_recon/targets": return { targets: [{ capture_time_us: 1_757_000_000_000_000+sequence,target_id: 901,type: 2,
      position: { longitude: 106.8149,latitude: 29.71955,altitude: 501 },velocity: { vel_e: 1,vel_n: 0,vel_u: 0 },
      distance: 20,confidence: 0.9,threat: 2,damage: 0,iff: 1,lock_time: 0,
      pixel_pos: { x: 10,y: 20,theta: 0,w: 30,h: 40 },role_name: "performance-target" }] };
    case "/ugv/area_recon/exception": return { kind: "equipment",level: 1,error_code: 1,time_us: 1_757_000_000_000_000+sequence,
      target_info: { reason: "performance-fixture" } };
  }
}
async function assertReady(): Promise<void> {
  const response = await fetch(readinessUrl,{ signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`UGV ingest readiness returned HTTP ${response.status}`);
  const body = await response.json() as { ready?: unknown };
  if (body.ready !== true) throw new Error("UGV ingest is not ready");
}
function linearSlope(points: Array<[number,number]>): number {
  if (points.length<2) return 0;
  const meanX = points.reduce((sum,[x]) => sum+x,0)/points.length;
  const meanY = points.reduce((sum,[,y]) => sum+y,0)/points.length;
  const denominator = points.reduce((sum,[x]) => sum+(x-meanX)**2,0);
  return denominator===0 ? 0 : points.reduce((sum,[x,y]) => sum+(x-meanX)*(y-meanY),0)/denominator;
}
function required(name: string): string { const value=process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function positiveInteger(name: string,fallback?: number): number { const value=Number(process.env[name] ?? fallback); if (!Number.isSafeInteger(value)||value<=0) throw new Error(`${name} must be a positive integer`); return value; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve,ms)); }
