import type pg from "pg";
import type { PlatformCommonDefinitionsReferenceKey } from "../../../../packages/platform/contract-runtime/src/index.js";
import { SituationRepository } from "../../../../packages/runtime/src/situation-repository.js";
import { WorldRepository } from "../../../../packages/runtime/src/world-repository.js";
import type { Geometry, SituationCell } from "../../../../packages/world-model-core/src/types.js";
import type { GowmSituationReadPort, SituationRankedRequest } from "./types.js";

export class RepositorySituationReadPort implements GowmSituationReadPort {
  constructor(
    private readonly situation: SituationRepository,
    private readonly world: WorldRepository,
    private readonly pool: pg.Pool,
    private readonly acceptedDataScope: string
  ) {}

  async getCells(dataScopeKey: string, indexes: string[]): Promise<SituationCell[]> {
    this.assertAcceptedScope(dataScopeKey);
    await this.assertSingleScopeDeployment();
    const result = await this.situation.getCells(indexes);
    await this.assertSingleScopeDeployment();
    return result;
  }

  async candidateReferences(
    dataScopeKey: string,
    indexes: string[],
    maximumReferences: number
  ): Promise<PlatformCommonDefinitionsReferenceKey[]> {
    this.assertAcceptedScope(dataScopeKey);
    await this.assertSingleScopeDeployment();
    const result = await this.pool.query<{ reference_key: unknown }>(
      `SELECT candidate.reference_key
       FROM (
         SELECT DISTINCT jsonb_build_object(
           'namespace', 'gowm',
           'kind', 'WORLD_OBJECT',
           'id', identity.reference_key,
           'version', state.version::text
         ) AS reference_key
         FROM world_object object
         JOIN world_object_state state ON state.object_id = object.id
         JOIN world_object_geometry geometry ON geometry.object_id = object.id
         JOIN world_reference_identity identity
           ON identity.entity_kind = 'WORLD_OBJECT'
          AND identity.internal_id = object.id
          AND identity.data_scope_key = object.data_scope_key
         WHERE object.data_scope_key = $1
           AND object.deleted_at IS NULL
           AND (
             geometry.h3_r7::text = ANY($2::text[])
             OR geometry.h3_r8::text = ANY($2::text[])
             OR geometry.h3_r9::text = ANY($2::text[])
             OR geometry.h3_r10::text = ANY($2::text[])
           )
       ) AS candidate
       ORDER BY candidate.reference_key->>'id'
       LIMIT $3`,
      [dataScopeKey, indexes, maximumReferences]
    );
    await this.assertSingleScopeDeployment();
    return result.rows.map((row) => referenceKey(row.reference_key));
  }

  async areaCells(dataScopeKey: string, area: Geometry, resolution: number): Promise<SituationCell[]> {
    this.assertAcceptedScope(dataScopeKey);
    await this.assertSingleScopeDeployment();
    const result = await this.situation.areaCells(area, resolution);
    await this.assertSingleScopeDeployment();
    return result;
  }

  async ranked(dataScopeKey: string, options: SituationRankedRequest): Promise<SituationCell[]> {
    this.assertAcceptedScope(dataScopeKey);
    await this.assertSingleScopeDeployment();
    const result = await this.situation.ranked(options);
    await this.assertSingleScopeDeployment();
    return result;
  }

  async worldVersion(dataScopeKey: string): Promise<number> {
    this.assertAcceptedScope(dataScopeKey);
    await this.assertSingleScopeDeployment();
    const result = await this.world.worldVersion();
    await this.assertSingleScopeDeployment();
    return result;
  }

  async readiness(): Promise<{ ready: boolean; reasons: string[] }> {
    try {
      await this.assertSingleScopeDeployment();
      const health = await this.world.health();
      return health.database ? { ready: true, reasons: [] } : { ready: false, reasons: ["world database is unavailable"] };
    } catch (error) {
      return { ready: false, reasons: [error instanceof Error ? error.message : "world database is unavailable"] };
    }
  }

  private assertAcceptedScope(dataScopeKey: string): void {
    if (dataScopeKey !== this.acceptedDataScope) {
      throw new Error("GOWM Situation repository adapter rejected a non-deployment data scope");
    }
  }

  private async assertSingleScopeDeployment(): Promise<void> {
    const result = await this.pool.query<{ scope_count: string | number; accepted_count: string | number }>(
      `SELECT count(*)::text AS scope_count,
              count(*) FILTER (WHERE scope_key = $1)::text AS accepted_count
       FROM data_scope`,
      [this.acceptedDataScope]
    );
    const row = result.rows[0];
    if (Number(row?.scope_count) !== 1 || Number(row?.accepted_count) !== 1) {
      throw new Error("GOWM Situation provider requires a verifiable single-scope deployment");
    }
  }
}

function referenceKey(value: unknown): PlatformCommonDefinitionsReferenceKey {
  const record = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("candidate reference is malformed");
  }
  const candidate = record as Record<string, unknown>;
  if (typeof candidate.namespace !== "string" || typeof candidate.kind !== "string" ||
      typeof candidate.id !== "string" || typeof candidate.version !== "string") {
    throw new Error("candidate reference is malformed");
  }
  return {
    namespace: candidate.namespace,
    kind: candidate.kind,
    id: candidate.id,
    version: candidate.version
  };
}
