import { loadConfig } from './config.js';
import { Database } from './db/database.js';
import { AnalysisService } from './application/analysis-service.js';
import { ToolRepository } from './repositories/tool-repository.js';
import { ToolRegistry } from './tools/registry.js';

/** Composition only; the protocol adapter delegates all analysis to this native service. */
export function createNativePlatformService(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const database = new Database(config);
  return { database, service: new AnalysisService(database, new ToolRepository(), new ToolRegistry(), config) };
}
