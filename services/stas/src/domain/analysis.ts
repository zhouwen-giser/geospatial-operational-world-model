export type AnalysisStatus = 'COMPLETE' | 'PARTIAL' | 'NO_DATA' | 'INDETERMINATE';
export type EvidenceLevel = 'SUMMARY' | 'STANDARD' | 'FULL';

export interface TimeRange {
  start: string;
  end: string;
  bounds: '[)' | '()' | '[]' | '(]';
}

export interface SubjectRef {
  kind: string;
  id: string;
  version?: string | number;
}

export interface EvidenceRef {
  id: string;
  type: string;
  timeRange?: TimeRange;
  summaryHash?: string;
}

export interface GapRef {
  id?: string;
  timeRange: TimeRange;
  reasonCodes: string[];
  observability?: string;
}

export interface UncertaintyStatement {
  quantity: string;
  model: 'HARD_RADIUS' | 'STDDEV' | 'COVARIANCE' | 'INTERVAL' | 'UNKNOWN';
  value?: unknown;
  unit?: string;
  confidenceLevel?: number;
  conclusion?: string;
  sourceRefs?: string[];
}

export interface Snapshot {
  dataScopeId: string;
  databaseSnapshotId?: string;
  trackletVersions: Array<{
    trackletId: string;
    trackletVersionId: string;
    versionNo: number;
  }>;
  timeSolutionIds?: string[];
  clockModelIds?: string[];
  spatialObjectVersionIds?: string[];
  coverageSliceIds?: string[];
  datastreamIds?: string[];
  sensorPoseVersionIds?: string[];
  sensorExtrinsicVersionIds?: string[];
  sensorStatusIntervalIds?: string[];
  detectorModelIds?: string[];
  watermarkRevisionIds?: string[];
  processingRunIds?: string[];
  ruleProfileIds?: string[];
  sourceReliabilityProfileIds?: string[];
}

export interface AnalysisResult<T> {
  schemaVersion: '1.0';
  analysisId: string;
  status: AnalysisStatus;
  generatedAt: string;
  subjects: SubjectRef[];
  query: Record<string, unknown>;
  result: T | null;
  coverage: {
    requestedTime?: TimeRange;
    evaluableTime?: TimeRange[];
    observedDurationMs?: number;
    requestedDurationMs?: number;
    temporalRatio?: number;
    spatialScope?: Array<{ id?: string; version?: string }>;
  };
  evidence: EvidenceRef[];
  gaps: GapRef[];
  uncertainties: UncertaintyStatement[];
  assumptions: Array<{ code: string; description: string }>;
  sourceReferences: Array<{ sourceId: string; rawReference?: string }>;
  quality: { grade: 'A' | 'B' | 'C' | 'D' | 'UNKNOWN'; score?: number; flags: string[] };
  method: {
    tool: string;
    toolVersion: string;
    algorithm: string;
    algorithmVersion: string;
    mobilityDbVersion: string;
    postgisVersion: string;
    interpolationPolicy: string;
    uncertaintyPolicy: string;
    metricDimension: '2D' | '3D';
    sqlTemplateHash: string;
  };
  snapshot: Snapshot;
  warnings: Array<{ code: string; message: string; intervals?: TimeRange[] }>;
  page?: { nextCursor?: string; returned: number; truncated: boolean };
  execution: { elapsedMs: number; candidateCount?: number; exactCount?: number; cacheHit: boolean };
}

export interface RepositoryExecution<T = unknown> {
  status: AnalysisStatus;
  result: T | null;
  subjects: SubjectRef[];
  snapshot: Omit<Snapshot, 'dataScopeId' | 'databaseSnapshotId'>;
  algorithm: string;
  sqlTemplateId: string;
  coverage?: AnalysisResult<T>['coverage'];
  evidence?: EvidenceRef[];
  gaps?: GapRef[];
  uncertainties?: UncertaintyStatement[];
  assumptions?: AnalysisResult<T>['assumptions'];
  sourceReferences?: AnalysisResult<T>['sourceReferences'];
  quality?: AnalysisResult<T>['quality'];
  warnings?: AnalysisResult<T>['warnings'];
  page?: AnalysisResult<T>['page'];
  candidateCount?: number;
  exactCount?: number;
  interpolationPolicy?: string;
  uncertaintyPolicy?: string;
}
