import { readFile } from "node:fs/promises";

export interface UgvIngestConfig {
  databaseUrl: string; mqttUrl: string; clientId: string; username?: string; password?: Buffer;
  ca?: Buffer; cert?: Buffer; key?: Buffer; sessionExpirySeconds: number; keepaliveSeconds: number;
  connectTimeoutMs: number; maxPayloadBytes: number; deviceId: string; dataScopeKey: string;
  originKind: "SIMULATION"; sourceKey: string; producerPipelineKey: string; scenarioId: string;
  worldEpoch: string; trackerSessionKey: string; analysisSpaceKey: string; analysisSrid: number;
  observationApiUrl: string; arrivalUncertaintyMs: number; port: number; codeVersion: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function integer(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback),10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
async function optionalFile(name: string): Promise<Buffer | undefined> {
  const path = process.env[name]?.trim();
  return path ? readFile(path) : undefined;
}

export async function loadUgvIngestConfig(): Promise<UgvIngestConfig> {
  const origin = process.env.UGV_ORIGIN_KIND ?? "SIMULATION";
  if (origin !== "SIMULATION") throw new Error("UGV_ORIGIN_KIND must be SIMULATION for this adapter");
  const analysisSrid = integer("UGV_ANALYSIS_SRID",32648);
  if (analysisSrid !== 32648) throw new Error("airport UGV analysis SRID must be EPSG:32648");
  const password = await optionalFile("UGV_MQTT_PASSWORD_FILE");
  const ca = await optionalFile("UGV_MQTT_CA_FILE");
  const cert = await optionalFile("UGV_MQTT_CERT_FILE");
  const key = await optionalFile("UGV_MQTT_KEY_FILE");
  return {
    databaseUrl: required("DATABASE_URL"),mqttUrl: required("UGV_MQTT_URL"),
    clientId: process.env.UGV_MQTT_CLIENT_ID ?? "gowm-ugv-ingest-airport-01",
    ...(process.env.UGV_MQTT_USERNAME ? { username: process.env.UGV_MQTT_USERNAME } : {}),
    ...(password ? { password } : {}),...(ca ? { ca } : {}),...(cert ? { cert } : {}),...(key ? { key } : {}),
    sessionExpirySeconds: integer("UGV_MQTT_SESSION_EXPIRY_SECONDS",86400),keepaliveSeconds: integer("UGV_MQTT_KEEPALIVE_SECONDS",30),
    connectTimeoutMs: integer("UGV_MQTT_CONNECT_TIMEOUT_MS",5000),maxPayloadBytes: integer("UGV_MQTT_MAX_PAYLOAD_BYTES",1048576),
    deviceId: process.env.UGV_DEVICE_ID ?? "ugv",dataScopeKey: process.env.UGV_DATA_SCOPE_KEY ?? "airport-sim-ugv-01",
    originKind: "SIMULATION",sourceKey: process.env.UGV_SOURCE_KEY ?? "ugv-airport-sim-mqtt",
    producerPipelineKey: process.env.UGV_PRODUCER_PIPELINE_KEY ?? "ugv-airport-sim-mqtt:canonical-v1",
    scenarioId: process.env.UGV_SCENARIO_ID ?? "airport",worldEpoch: required("UGV_WORLD_EPOCH"),
    trackerSessionKey: required("UGV_TRACKER_SESSION_KEY"),analysisSpaceKey: process.env.UGV_ANALYSIS_SPACE_KEY ?? "airport-utm48n",
    analysisSrid,observationApiUrl: process.env.GOWM_OBSERVATION_API_URL ?? "http://observation-ingest:3002",
    arrivalUncertaintyMs: integer("UGV_MQTT_ARRIVAL_TIME_UNCERTAINTY_MS",1000),port: integer("UGV_MQTT_INGEST_PORT",3010),
    codeVersion: process.env.SERVICE_REVISION ?? "dev"
  };
}
