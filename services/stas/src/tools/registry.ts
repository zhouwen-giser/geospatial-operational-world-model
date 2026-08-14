import type { ZodTypeAny } from 'zod';
import type { ErrorCode } from '../domain/errors.js';
import { toolSchemas, type ToolName } from './schemas.js';

export type CostClass = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ToolDefinition {
  name: ToolName;
  version: '1.0.0';
  description: string;
  inputSchemaUri: string;
  outputSchemaUri: string;
  schema: ZodTypeAny;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  costClass: CostClass;
  maxRows: number;
  maxCandidates?: number;
  dataScopePolicy: 'REQUIRED_EXACT_MATCH';
  interpolationPolicy: 'TOOL_DECLARED_NO_CROSS_GAP';
  gapPolicy: 'UNKNOWN_DOMAIN_EXPLICIT';
  uncertaintyPolicy: 'REPORT_SEPARATE_DIMENSIONS';
  idempotent: true;
  cacheableWhenPinned: true;
  errorCodes: ErrorCode[];
}

const commonErrors: ErrorCode[] = [
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'DATA_SCOPE_FORBIDDEN',
  'DEADLINE_EXCEEDED',
  'SNAPSHOT_NOT_AVAILABLE',
];

function definition(
  name: ToolName,
  description: string,
  defaultTimeoutMs: number,
  maxTimeoutMs: number,
  costClass: CostClass,
  maxRows: number,
  extraErrors: ErrorCode[] = [],
  maxCandidates?: number,
): ToolDefinition {
  return {
    name,
    version: '1.0.0',
    description,
    inputSchemaUri: `#/components/schemas/${name}_input_v1`,
    outputSchemaUri: '#/components/schemas/AnalysisResult',
    schema: toolSchemas[name],
    defaultTimeoutMs,
    maxTimeoutMs,
    costClass,
    maxRows,
    ...(maxCandidates === undefined ? {} : { maxCandidates }),
    dataScopePolicy: 'REQUIRED_EXACT_MATCH',
    interpolationPolicy: 'TOOL_DECLARED_NO_CROSS_GAP',
    gapPolicy: 'UNKNOWN_DOMAIN_EXPLICIT',
    uncertaintyPolicy: 'REPORT_SEPARATE_DIMENSIONS',
    idempotent: true,
    cacheableWhenPinned: true,
    errorCodes: [...commonErrors, ...extraErrors],
  };
}

const definitions: ToolDefinition[] = [
  definition('get_tracklet', 'Read one immutable source-local tracklet version.', 2000, 5000, 'LOW', 1000, ['AMBIGUOUS_VERSION', 'RESPONSE_TOO_LARGE']),
  definition('get_tracklet_gaps', 'Read explicit unknown gaps and their builder reasons.', 2000, 5000, 'LOW', 1000, ['AMBIGUOUS_VERSION', 'TOO_MANY_RESULTS']),
  definition('get_tracklet_quality', 'Return independent coverage, uncertainty, health, and provenance dimensions.', 3000, 8000, 'LOW', 20, ['INSUFFICIENT_PROVENANCE']),
  definition('slice_tracklet', 'Restrict a frozen tracklet by time and/or a versioned region without filling gaps.', 3000, 8000, 'MEDIUM', 100, ['CRS_MISMATCH', 'UNSUPPORTED_DIMENSION']),
  definition('get_position_at', 'Return observed, interpolated, or unknown position at one timestamp.', 2000, 5000, 'LOW', 1, ['UNSUPPORTED_INTERPOLATION']),
  definition('get_motion_summary', 'Compute per-sequence, gap-aware motion summaries.', 3000, 8000, 'MEDIUM', 100, ['UNSUPPORTED_INTERPOLATION', 'INSUFFICIENT_QUALITY']),
  definition('find_stop_intervals', 'Extract parameterized stop intervals within continuous sequences.', 5000, 10_000, 'MEDIUM', 1000, ['UNSUPPORTED_INTERPOLATION', 'TOO_MANY_RESULTS']),
  definition('find_region_interactions', 'Extract visit and boundary interaction facts for one versioned region.', 5000, 10_000, 'MEDIUM', 1000, ['CRS_MISMATCH', 'TOO_MANY_RESULTS']),
  definition('find_tracklets_in_region', 'Find scoped tracklet candidates or exact region visits.', 10_000, 20_000, 'HIGH', 5000, ['CRS_MISMATCH', 'TOO_MANY_CANDIDATES'], 5000),
  definition('nearest_approach', 'Compute nominal nearest approach over the common defined temporal domain.', 5000, 10_000, 'MEDIUM', 1, ['CRS_MISMATCH', 'UNSUPPORTED_DIMENSION']),
  definition('find_proximity_intervals', 'Extract nominal proximity intervals and controlled uncertainty sensitivity.', 5000, 12_000, 'MEDIUM', 1000, ['CRS_MISMATCH', 'UNSUPPORTED_UNCERTAINTY_MODEL', 'TOO_MANY_RESULTS', 'QUERY_BUDGET_EXCEEDED']),
  definition('find_nearby_tracklets', 'Generate a complete, budgeted nearby candidate set before exact evaluation.', 10_000, 20_000, 'HIGH', 5000, ['UNSUPPORTED_UNCERTAINTY_MODEL', 'TOO_MANY_CANDIDATES'], 5000),
  definition('find_successor_candidates', 'Generate physically reachable successor candidates without identity verdicts.', 10_000, 20_000, 'HIGH', 5000, ['UNSUPPORTED_UNCERTAINTY_MODEL', 'TOO_MANY_CANDIDATES', 'UNSUPPORTED_REACHABILITY_LEVEL'], 5000),
  definition('compare_pair_features', 'Produce typed deterministic pair features for higher-level reasoning.', 8000, 20_000, 'HIGH', 32, ['CRS_MISMATCH', 'UNSUPPORTED_FEATURE', 'QUERY_BUDGET_EXCEEDED']),
  definition('find_sensor_coverage', 'Read frozen sensor coverage, status, pose, detector, and watermark prerequisites.', 5000, 10_000, 'MEDIUM', 1000, ['CRS_MISMATCH', 'TOO_MANY_CANDIDATES'], 1000),
];

const byName = new Map<ToolName, ToolDefinition>(definitions.map((item) => [item.name, item]));

export class ToolRegistry {
  public list(): ToolDefinition[] {
    return definitions.map((item) => ({ ...item, errorCodes: [...item.errorCodes] }));
  }

  public get(name: string): ToolDefinition | undefined {
    return byName.get(name as ToolName);
  }

  public describe(definition: ToolDefinition): Omit<ToolDefinition, 'schema'> {
    const { schema: _schema, ...publicDefinition } = definition;
    return publicDefinition;
  }
}
