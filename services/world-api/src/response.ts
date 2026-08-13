import type { AgentToolResponse } from "../../../packages/world-model-core/src/types.js";

export async function timedResponse<T>(
  worldVersion: () => Promise<number>,
  action: () => Promise<T>,
  summary: (facts: T) => Record<string, unknown>,
  freshnessValues: (facts: T) => Array<number | undefined> = () => []
): Promise<AgentToolResponse<T>> {
  const started = performance.now();
  const facts = await action();
  const version = await worldVersion();
  const freshness = freshnessValues(facts).filter((value): value is number => value !== undefined && Number.isFinite(value));
  return {
    summary: summary(facts),
    facts,
    context: {
      worldVersion: version,
      dataFreshnessMs: freshness.length ? Math.max(...freshness) : null,
      queryTimeMs: Math.round((performance.now() - started) * 100) / 100
    }
  };
}
