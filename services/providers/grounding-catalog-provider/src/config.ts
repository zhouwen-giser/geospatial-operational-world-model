import pg from "pg";
import { validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { GroundingCatalogProviderOptions } from "./provider.js";
import type { CatalogSqlClient, CatalogSqlPool, GroundingCatalogMode } from "./types.js";

export interface GroundingCatalogServerConfig {
  host: string;
  port: number;
  transportToken: string;
  provider: GroundingCatalogProviderOptions;
  close(): Promise<void>;
}

export function loadGroundingCatalogConfig(env: NodeJS.ProcessEnv = process.env): GroundingCatalogServerConfig {
  const mode = requiredMode(env.GROUNDING_CATALOG_MODE);
  const connectionString = required(env, "GROUNDING_CATALOG_DATABASE_URL");
  const cursorSecret = required(env, "GROUNDING_CATALOG_CURSOR_HMAC_SECRET");
  if (Buffer.byteLength(cursorSecret, "utf8") < 32) throw new Error("GROUNDING_CATALOG_CURSOR_HMAC_SECRET must contain at least 32 bytes");
  const pool = new pg.Pool({
    connectionString,
    application_name: `gowm-${mode}-catalog-provider`,
    max: bounded(env.GROUNDING_CATALOG_POOL_SIZE, 8, 128, "GROUNDING_CATALOG_POOL_SIZE"),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
  pool.on("error", (error) => process.stderr.write(`grounding catalog pool error: ${error.message}\n`));
  const adapter: CatalogSqlPool = {
    async connect(): Promise<CatalogSqlClient> {
      const client = await pool.connect();
      return {
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
          const query = await client.query(text, values === undefined ? undefined : [...values]);
          return { rows: query.rows as Row[], rowCount: query.rowCount };
        },
        release: () => client.release()
      };
    },
    end: () => pool.end()
  };
  return {
    host: env.GROUNDING_CATALOG_HOST?.trim() || "0.0.0.0",
    port: tcpPort(env.GROUNDING_CATALOG_PORT, mode === "reference" ? 8090 : mode === "dataset" ? 8091 : 8093, "GROUNDING_CATALOG_PORT"),
    transportToken: validateProviderTransportToken(env.PROVIDER_TRANSPORT_SHARED_TOKEN),
    provider: {
      mode,
      pool: adapter,
      cursorSecret,
      statementTimeoutMs: positive(env.GROUNDING_CATALOG_STATEMENT_TIMEOUT_MS, 5_000, "GROUNDING_CATALOG_STATEMENT_TIMEOUT_MS"),
      lockTimeoutMs: positive(env.GROUNDING_CATALOG_LOCK_TIMEOUT_MS, 1_000, "GROUNDING_CATALOG_LOCK_TIMEOUT_MS"),
      maximumRows: bounded(env.GROUNDING_CATALOG_MAXIMUM_ROWS, 1_000, 1_000, "GROUNDING_CATALOG_MAXIMUM_ROWS"),
      maximumCandidates: bounded(env.GROUNDING_CATALOG_MAXIMUM_CANDIDATES, 5_000, 5_000, "GROUNDING_CATALOG_MAXIMUM_CANDIDATES")
    },
    close: () => pool.end()
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function requiredMode(value: string | undefined): GroundingCatalogMode { if (value !== "reference" && value !== "dataset" && value !== "result") throw new Error("GROUNDING_CATALOG_MODE must be reference, dataset, or result"); return value; }
function positive(raw: string | undefined, fallback: number, name: string): number { const value = raw === undefined ? fallback : Number(raw); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive`); return value; }
function bounded(raw: string | undefined, fallback: number, maximum: number, name: string): number { const value = positive(raw, fallback, name); if (value > maximum) throw new Error(`${name} must not exceed ${maximum}`); return value; }
function tcpPort(raw: string | undefined, fallback: number, name: string): number { return bounded(raw, fallback, 65_535, name); }
