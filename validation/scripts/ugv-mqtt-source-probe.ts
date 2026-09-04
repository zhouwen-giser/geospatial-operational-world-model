import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import mqtt from "mqtt";
import { UGV_AUTHORITY_TOPICS, type UgvAuthorityTopic } from "../../packages/integrations/ugv-mqtt-ingest-core/src/contracts.js";

const rawUrl = required("UGV_MQTT_SOURCE_BROKER_URL");
const durationSeconds = boundedInteger("UGV_MQTT_SOURCE_PROBE_SECONDS",30,5,600);
const outputPath = process.env.UGV_MQTT_SOURCE_PROBE_OUTPUT?.trim();
if (outputPath && !outputPath.startsWith("/")) throw new Error("UGV_MQTT_SOURCE_PROBE_OUTPUT must be absolute when set");
const broker = new URL(rawUrl);
if (!["mqtt:","mqtts:","ws:","wss:"].includes(broker.protocol) || broker.password) {
  throw new Error("source broker URL must use MQTT and must not embed a password");
}

interface TopicEvidence {
  messages: number;
  qosLevels: number[];
  retainedMessages: number;
  minimumPayloadBytes: number;
  maximumPayloadBytes: number;
  payloadShapes: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

const observed = new Map<UgvAuthorityTopic,{
  messages: number; qosLevels: Set<number>; retainedMessages: number; minimumPayloadBytes: number;
  maximumPayloadBytes: number; payloadShapes: Set<string>; firstSeenAt: string; lastSeenAt: string;
}>();
const client = await mqtt.connectAsync(broker.toString(),{
  protocolVersion: 5,clean: true,clientId: `gowm-ugv-source-probe-${randomUUID()}`,reconnectPeriod: 0,
  ...(broker.username ? { username: decodeURIComponent(broker.username) } : {})
});
try {
  client.on("message",(topic,payload,packet) => {
    if (!(UGV_AUTHORITY_TOPICS as readonly string[]).includes(topic)) return;
    const key = topic as UgvAuthorityTopic;
    const now = new Date().toISOString();
    const current = observed.get(key) ?? {
      messages: 0,qosLevels: new Set<number>(),retainedMessages: 0,minimumPayloadBytes: payload.byteLength,
      maximumPayloadBytes: payload.byteLength,payloadShapes: new Set<string>(),firstSeenAt: now,lastSeenAt: now
    };
    current.messages += 1;
    current.qosLevels.add(packet.qos);
    current.retainedMessages += packet.retain ? 1 : 0;
    current.minimumPayloadBytes = Math.min(current.minimumPayloadBytes,payload.byteLength);
    current.maximumPayloadBytes = Math.max(current.maximumPayloadBytes,payload.byteLength);
    current.payloadShapes.add(payloadShape(payload));
    current.lastSeenAt = now;
    observed.set(key,current);
  });
  const grants = await client.subscribeAsync(Object.fromEntries(
    UGV_AUTHORITY_TOPICS.map((topic) => [topic,{ qos: 1 as const }])
  ));
  await new Promise((resolve) => setTimeout(resolve,durationSeconds*1_000));
  const grantByTopic = Object.fromEntries(grants.map((grant) => [grant.topic,grant.qos]));
  const evidence = Object.fromEntries(UGV_AUTHORITY_TOPICS.flatMap((topic) => {
    const value = observed.get(topic);
    if (!value) return [];
    const normalized: TopicEvidence = {
      messages: value.messages,qosLevels: [...value.qosLevels].sort(),retainedMessages: value.retainedMessages,
      minimumPayloadBytes: value.minimumPayloadBytes,maximumPayloadBytes: value.maximumPayloadBytes,
      payloadShapes: [...value.payloadShapes].sort(),firstSeenAt: value.firstSeenAt,lastSeenAt: value.lastSeenAt
    };
    return [[topic,normalized] as const];
  }));
  const qosConflicts = UGV_AUTHORITY_TOPICS.flatMap((topic) => {
    const levels = observed.get(topic)?.qosLevels;
    return levels && [...levels].some((qos) => qos<1) ? [{ topic,observedQos: [...levels].sort() }] : [];
  });
  const notObserved = UGV_AUTHORITY_TOPICS.filter((topic) => !observed.has(topic));
  const subackFailures = UGV_AUTHORITY_TOPICS.filter((topic) => grantByTopic[topic] !== 1);
  const status = qosConflicts.length || subackFailures.length
    ? "BLOCKED_SOURCE_CONTRACT_CONFLICT"
    : notObserved.length ? "INCOMPLETE_OBSERVATION_WINDOW" : "PASS";
  const report = {
    schemaVersion: "1.0",status,probeKind: "READ_ONLY_SUBSCRIPTION",broker: `${broker.hostname}:${broker.port || "1883"}`,
    durationSeconds,requestedQos: 1,topics: UGV_AUTHORITY_TOPICS,suback: grantByTopic,observed: evidence,
    notObservedInWindow: notObserved,qosConflicts,subackFailures,
    interpretation: "A QoS 1 subscription is only a delivery ceiling; an observed QoS 0 PUBLISH cannot be upgraded or acknowledged with PUBACK."
  };
  const serialized = `${JSON.stringify(report,null,2)}\n`;
  if (outputPath) await writeFile(outputPath,serialized,{ encoding: "utf8",mode: 0o600 });
  process.stdout.write(serialized);
  if (status === "BLOCKED_SOURCE_CONTRACT_CONFLICT") process.exitCode = 2;
} finally {
  await client.endAsync();
}

function payloadShape(payload: Buffer): string {
  try {
    const value = JSON.parse(payload.toString("utf8")) as unknown;
    if (Array.isArray(value)) return "JSON_ARRAY";
    if (value && typeof value === "object") {
      const record = value as Record<string,unknown>;
      if (typeof record.data === "string") {
        try {
          const inner = JSON.parse(record.data) as unknown;
          return inner && typeof inner === "object" ? "STRING_WRAPPED_JSON" : "STRING_WRAPPED_SCALAR";
        } catch { return "STRING_WRAPPED_TEXT"; }
      }
      return "JSON_OBJECT";
    }
    return "JSON_SCALAR";
  } catch { return "NON_JSON"; }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(name: string,fallback: number,minimum: number,maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value<minimum || value>maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}
