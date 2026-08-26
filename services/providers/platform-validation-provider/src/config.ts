import pg from "pg";
import { validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";
import { PostgresPlatformValidationAuthority } from "./postgres-authority.js";

export interface PlatformValidationServerConfig {
  host: string;
  port: number;
  transportToken: string;
  authority: PostgresPlatformValidationAuthority;
  close(): Promise<void>;
}

export function loadPlatformValidationConfig(env: NodeJS.ProcessEnv = process.env): PlatformValidationServerConfig {
  const connectionString = required(env, "PLATFORM_VALIDATION_DATABASE_URL");
  const pool = new pg.Pool({ connectionString, application_name: "gowm-platform-validation-provider", max: bounded(env.PLATFORM_VALIDATION_POOL_SIZE, 8, 64, "PLATFORM_VALIDATION_POOL_SIZE"), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on("error", () => process.stderr.write("platform validation pool error\n"));
  return {
    host: env.PLATFORM_VALIDATION_HOST?.trim() || "0.0.0.0",
    port: bounded(env.PLATFORM_VALIDATION_PORT, 8095, 65_535, "PLATFORM_VALIDATION_PORT"),
    transportToken: validateProviderTransportToken(env.PROVIDER_TRANSPORT_SHARED_TOKEN),
    authority: new PostgresPlatformValidationAuthority(pool, bounded(env.PLATFORM_VALIDATION_STATEMENT_TIMEOUT_MS, 5_000, 30_000, "PLATFORM_VALIDATION_STATEMENT_TIMEOUT_MS")),
    close: () => pool.end()
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function bounded(raw: string | undefined, fallback: number, maximum: number, name: string): number { const value = raw === undefined ? fallback : Number(raw); if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be between 1 and ${maximum}`); return value; }
