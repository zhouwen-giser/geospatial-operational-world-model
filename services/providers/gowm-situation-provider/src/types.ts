import type { Geometry, SituationCell } from "../../../../packages/world-model-core/src/types.js";
import type { PlatformCommonDefinitionsReferenceKey } from "../../../../packages/platform/contract-runtime/src/index.js";

export interface SituationRankedRequest {
  resolution: number;
  metric: "activity" | "risk" | "coverage" | "freshness" | "observations";
  order: "ASC" | "DESC";
  limit: number;
  parentCell?: string;
}

/** Narrow GOWM-owned projection read boundary. It deliberately exposes no generic H3 kernel methods. */
export interface GowmSituationReadPort {
  getCells(dataScopeKey: string, indexes: string[]): Promise<SituationCell[]>;
  candidateReferences(
    dataScopeKey: string,
    indexes: string[],
    maximumReferences: number
  ): Promise<PlatformCommonDefinitionsReferenceKey[]>;
  areaCells(dataScopeKey: string, area: Geometry, resolution: number): Promise<SituationCell[]>;
  ranked(dataScopeKey: string, options: SituationRankedRequest): Promise<SituationCell[]>;
  worldVersion(dataScopeKey: string): Promise<number>;
  readiness?(): Promise<{ ready: boolean; reasons: string[] }>;
}
