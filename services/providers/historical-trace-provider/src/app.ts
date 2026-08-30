import type { FastifyInstance } from "fastify";
import { buildProviderProtocolApp } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { HistoricalTraceProvider } from "./provider.js";

/**
 * Exposes the Historical Trace Provider through the shared Gateway-to-Provider
 * protocol. The application has no route or client capable of calling another
 * Provider; all authoritative reads remain inside the scoped repository.
 */
export function buildHistoricalTraceApp(
  provider: HistoricalTraceProvider,
  transportToken: string
): FastifyInstance {
  return buildProviderProtocolApp(
    provider.runtime,
    transportToken,
    () => provider.repository.readiness()
  );
}
