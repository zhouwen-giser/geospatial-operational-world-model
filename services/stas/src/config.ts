import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.string().default('info'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).default(2000),
  SERVICE_VERSION: z.string().default('0.1.0'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
