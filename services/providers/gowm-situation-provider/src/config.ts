import { databasePool } from "../../../../packages/runtime/src/db.js";
import { SituationRepository } from "../../../../packages/runtime/src/situation-repository.js";
import { WorldRepository } from "../../../../packages/runtime/src/world-repository.js";
import { RepositorySituationReadPort } from "./repository-adapter.js";
import { validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";

export interface GowmSituationServerConfig {
  host: string;
  port: number;
  transportToken: string;
  provider: { port: RepositorySituationReadPort; acceptedDataScope: string };
  close(): Promise<void>;
}

export function loadGowmSituationServerConfig(env: NodeJS.ProcessEnv = process.env): GowmSituationServerConfig {
  const transportToken = validateProviderTransportToken(env.PROVIDER_TRANSPORT_SHARED_TOKEN);
  const pool = databasePool();
  const acceptedDataScope = env.GOWM_SITUATION_ACCEPTED_DATA_SCOPE ?? "default";
  if (!acceptedDataScope.trim()) throw new Error("GOWM_SITUATION_ACCEPTED_DATA_SCOPE is required");
  return {
    host: env.GOWM_SITUATION_PROVIDER_HOST ?? "0.0.0.0",
    port: integerEnv(env, "GOWM_SITUATION_PROVIDER_PORT", 3114),
    transportToken,
    provider: {
      port: new RepositorySituationReadPort(new SituationRepository(pool), new WorldRepository(pool), pool, acceptedDataScope),
      acceptedDataScope
    },
    close: () => pool.end()
  };
}

function integerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid TCP port`);
  return value;
}
