import pg from "pg";
import type { SpatialProviderBridgeOptions } from "./provider.js";
import type { SpatialSqlClient, SpatialSqlPool } from "./types.js";
import { validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";

export interface SpatialBridgeServerConfig {
  host: string;
  port: number;
  transportToken: string;
  provider: SpatialProviderBridgeOptions;
  close(): Promise<void>;
}

export function loadSpatialBridgeServerConfig(env: NodeJS.ProcessEnv = process.env): SpatialBridgeServerConfig {
  const connectionString = required(env, "SPATIAL_DATABASE_URL");
  const cursorSecret = required(env, "SPATIAL_CURSOR_HMAC_SECRET");
  const postgisVersion = required(env, "SPATIAL_POSTGIS_VERSION");
  if (Buffer.byteLength(cursorSecret, "utf8") < 32) throw new Error("SPATIAL_CURSOR_HMAC_SECRET must contain at least 32 bytes");
  const poolSize = boundedPositiveInteger(env.SPATIAL_POOL_SIZE, 8, 128, "SPATIAL_POOL_SIZE");
  const statementTimeoutMs = positiveInteger(env.SPATIAL_STATEMENT_TIMEOUT_MS, 5_000, "SPATIAL_STATEMENT_TIMEOUT_MS");
  const lockTimeoutMs = positiveInteger(env.SPATIAL_LOCK_TIMEOUT_MS, 1_000, "SPATIAL_LOCK_TIMEOUT_MS");
  const maximumRows = boundedPositiveInteger(env.SPATIAL_MAXIMUM_ROWS, 10_000, 10_000, "SPATIAL_MAXIMUM_ROWS");
  const maximumCandidates = boundedPositiveInteger(env.SPATIAL_MAXIMUM_CANDIDATES, 50_000, 50_000, "SPATIAL_MAXIMUM_CANDIDATES");
  const maximumEvidenceReferences = boundedPositiveInteger(env.SPATIAL_MAXIMUM_EVIDENCE_REFERENCES, 1_000, 1_000, "SPATIAL_MAXIMUM_EVIDENCE_REFERENCES");
  const pool = new pg.Pool({
    connectionString,
    application_name: "gowm-spatial-provider",
    max: poolSize,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
  pool.on("error", (error) => process.stderr.write(`spatial read pool error: ${error.message}\n`));
  const adapter: SpatialSqlPool = {
    async connect(): Promise<SpatialSqlClient> {
      const client = await pool.connect();
      return {
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
          const result = await client.query(text, values === undefined ? undefined : [...values]);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
        release: () => client.release()
      };
    },
    end: () => pool.end()
  };
  return {
    host: env.SPATIAL_BRIDGE_HOST?.trim() || "0.0.0.0",
    port: tcpPort(env.SPATIAL_BRIDGE_PORT, 8089, "SPATIAL_BRIDGE_PORT"),
    transportToken: validateProviderTransportToken(env.PROVIDER_TRANSPORT_SHARED_TOKEN),
    provider: {
      pool: adapter,
      cursorSecret,
      postgisVersion,
      statementTimeoutMs,
      lockTimeoutMs,
      maximumRows,
      maximumCandidates,
      maximumEvidenceReferences
    },
    close: () => pool.end()
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function boundedPositiveInteger(raw: string | undefined, fallback: number, maximum: number, name: string): number {
  const value = positiveInteger(raw, fallback, name);
  if (value > maximum) throw new Error(`${name} must not exceed ${maximum}`);
  return value;
}

function tcpPort(raw: string | undefined, fallback: number, name: string): number {
  const value = positiveInteger(raw, fallback, name);
  if (value > 65_535) throw new Error(`${name} must not exceed 65535`);
  return value;
}
