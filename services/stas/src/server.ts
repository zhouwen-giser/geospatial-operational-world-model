import { createApp } from './app.js';
import { AnalysisService } from './application/analysis-service.js';
import { loadConfig } from './config.js';
import { Database } from './db/database.js';
import { ToolRepository } from './repositories/tool-repository.js';
import { ToolRegistry } from './tools/registry.js';

const config = loadConfig();
const database = new Database(config);
const registry = new ToolRegistry();
const analysisService = new AnalysisService(database, new ToolRepository(), registry, config);
const app = createApp({ config, database, analysisService, registry });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await database.close();
  process.exit(0);
};

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error);
  await database.close();
  process.exit(1);
}
