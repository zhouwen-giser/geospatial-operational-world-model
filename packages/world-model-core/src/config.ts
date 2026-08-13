export interface AppConfig {
  databaseUrl: string;
  mqttUrl: string;
  mqttConnectTimeoutMs: number;
  mqttMessageExpirySec: number;
  worldApiUrl: string;
  observationApiUrl: string;
  worldApiPort: number;
  observationApiPort: number;
  mcpPort: number;
  defaultH3Resolution: number;
  staleAfterMs: number;
  maxFutureSkewMs: number;
  maxLateArrivalMs: number;
  projectionBatchSize: number;
  projectionPollMs: number;
  sourcePriorities: Record<string, number>;
  analysisSrid: number;
  analysisSpaceKey: string;
  trackletMaxTimeGapMs: number;
  trackletMaxDistanceGapM: number;
  trackletMaxRequiredSpeedMps: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`Invalid integer environment variable ${name}`);
  return value;
}

export function parseSourcePriorities(raw: string | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  for (const entry of (raw ?? "camera:70,uav:80,ugv:75,sensor:60,operator:100,simulator:50").split(",")) {
    const [source, scoreRaw] = entry.split(":");
    const score = Number(scoreRaw);
    if (source && Number.isFinite(score)) result[source.trim().toLowerCase()] = score;
  }
  return result;
}

export function loadConfig(): AppConfig {
  return {
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://gowm:gowm@localhost:5432/gowm",
    mqttUrl: process.env.MQTT_URL ?? "mqtt://localhost:1883",
    mqttConnectTimeoutMs: intEnv("MQTT_CONNECT_TIMEOUT_MS", 5_000),
    mqttMessageExpirySec: intEnv("MQTT_MESSAGE_EXPIRY_SEC", 86_400),
    worldApiUrl: process.env.WORLD_API_URL ?? "http://localhost:3000",
    observationApiUrl: process.env.OBSERVATION_API_URL ?? "http://localhost:3002",
    worldApiPort: intEnv("WORLD_API_PORT", 3000),
    observationApiPort: intEnv("OBSERVATION_API_PORT", 3002),
    mcpPort: intEnv("MCP_PORT", 3001),
    defaultH3Resolution: intEnv("DEFAULT_H3_RESOLUTION", 9),
    staleAfterMs: intEnv("STALE_AFTER_MS", 30_000),
    maxFutureSkewMs: intEnv("MAX_FUTURE_SKEW_MS", 300_000),
    maxLateArrivalMs: intEnv("MAX_LATE_ARRIVAL_MS", 86_400_000),
    projectionBatchSize: intEnv("PROJECTION_BATCH_SIZE", 200),
    projectionPollMs: intEnv("PROJECTION_POLL_MS", 250),
    sourcePriorities: parseSourcePriorities(process.env.SOURCE_PRIORITIES),
    analysisSrid: intEnv("ANALYSIS_SRID", 32650),
    analysisSpaceKey: process.env.ANALYSIS_SPACE_KEY ?? "default",
    trackletMaxTimeGapMs: intEnv("TRACKLET_MAX_TIME_GAP_MS", 10_000),
    trackletMaxDistanceGapM: intEnv("TRACKLET_MAX_DISTANCE_GAP_M", 250),
    trackletMaxRequiredSpeedMps: intEnv("TRACKLET_MAX_REQUIRED_SPEED_MPS", 80)
  };
}
