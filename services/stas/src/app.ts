import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Database } from './db/database.js';
import type { AnalysisService } from './application/analysis-service.js';
import { AppError } from './domain/errors.js';
import { errorHandler } from './api/problem.js';
import { requireDataScopeHeader, requireMatchingDataScope } from './api/scope.js';
import type { ToolRegistry } from './tools/registry.js';

export interface AppDependencies {
  config: Config;
  database: Database;
  analysisService: AnalysisService;
  registry: ToolRegistry;
}

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: { level: dependencies.config.LOG_LEVEL },
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 65_000,
    routerOptions: { maxParamLength: 128 },
  });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(async () => {
    throw new AppError('NOT_FOUND', 404, 'Route not found', 'No route matches this request.');
  });

  app.get('/healthz', async () => ({ status: 'ok', serviceVersion: dependencies.config.SERVICE_VERSION }));
  app.get('/readyz', async () => {
    const metadata = await dependencies.database.withTransaction(1000, 'REPEATABLE_READ', (transaction) => transaction.runtimeMetadata());
    return { status: 'ready', ...metadata };
  });

  app.get('/v1/tools', async () => ({
    tools: dependencies.registry.list().map((definition) => dependencies.registry.describe(definition)),
  }));

  app.get<{ Params: { name: string } }>('/v1/tools/:name', async (request) => {
    const definition = dependencies.registry.get(request.params.name);
    if (definition === undefined) throw new AppError('NOT_FOUND', 404, 'Tool not found', 'No registered tool has this name.');
    return dependencies.registry.describe(definition);
  });

  app.post<{ Params: { name: string } }>('/v1/tools/:name([^:]+)::execute', async (request, reply) => {
    requireMatchingDataScope(request.headers['x-data-scope-id'], request.body);
    const result = await dependencies.analysisService.execute(request.params.name, request.body);
    return reply.status(200).send(result);
  });

  app.get<{ Params: { analysisId: string } }>('/v1/analyses/:analysisId', async (request) => {
    const dataScopeId = requireDataScopeHeader(request.headers['x-data-scope-id']);
    return dependencies.analysisService.get(request.params.analysisId, dataScopeId);
  });

  return app;
}
