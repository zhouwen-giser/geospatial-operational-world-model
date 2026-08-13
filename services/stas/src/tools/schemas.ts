import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const timestampSchema = z.string().datetime({ offset: true });

export const timeRangeSchema = z.object({
  start: timestampSchema,
  end: timestampSchema,
  bounds: z.literal('[)').default('[)'),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.start) >= Date.parse(value.end)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['end'], message: 'end must be after start' });
  }
});

export const trackletVersionRefSchema = z.object({
  trackletId: uuidSchema,
  trackletVersionId: uuidSchema.optional(),
  versionNo: z.number().int().positive().optional(),
}).strict().superRefine((value, context) => {
  if ((value.trackletVersionId === undefined) === (value.versionNo === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provide exactly one of trackletVersionId or versionNo',
    });
  }
});

const commonFields = {
  dataScopeId: uuidSchema,
  snapshotPolicy: z.literal('PINNED').default('PINNED'),
  evidenceLevel: z.enum(['SUMMARY', 'STANDARD', 'FULL']).default('SUMMARY'),
  deadlineMs: z.number().int().min(1000).max(60_000).optional(),
};

function pinnedSnapshotPolicy(_value: { snapshotPolicy: 'PINNED' }, _context: z.RefinementCtx): void {}

const trackletInputBase = {
  ...commonFields,
  tracklet: trackletVersionRefSchema,
};

export const getTrackletInputSchema = z.object({
  ...trackletInputBase,
  detail: z.enum(['SUMMARY', 'SEQUENCES', 'OBSERVATION_REFS']).default('SUMMARY'),
  limit: z.number().int().min(1).max(1000).default(100),
}).strict().superRefine(pinnedSnapshotPolicy);

export const getTrackletGapsInputSchema = z.object({
  ...trackletInputBase,
  timeRange: timeRangeSchema,
  reasons: z.array(z.string().min(1).max(64)).max(32).default([]),
  limit: z.number().int().min(1).max(1000).default(1000),
}).strict().superRefine(pinnedSnapshotPolicy);

export const getTrackletQualityInputSchema = z.object({
  ...trackletInputBase,
  timeRange: timeRangeSchema.optional(),
  dimensions: z.array(z.enum([
    'TEMPORAL_COVERAGE',
    'POSITION_UNCERTAINTY',
    'SOURCE_HEALTH',
    'PROVENANCE',
    'CONFLICTS',
    'SAMPLING',
  ])).min(1).max(20),
}).strict().superRefine(pinnedSnapshotPolicy);

const regionRefSchema = z.object({
  spatialObjectId: uuidSchema,
  spatialObjectVersionId: uuidSchema,
}).strict();

export const sliceTrackletInputSchema = z.object({
  ...trackletInputBase,
  timeRange: timeRangeSchema.optional(),
  region: regionRefSchema.optional(),
  spatialMode: z.literal('INTERSECTS_INCLUSIVE_BOUNDARY').default('INTERSECTS_INCLUSIVE_BOUNDARY'),
  boundaryPolicy: z.enum(['REPORT_AMBIGUOUS', 'NOMINAL']).default('REPORT_AMBIGUOUS'),
}).strict().superRefine((value, context) => {
  pinnedSnapshotPolicy(value, context);
  if (value.timeRange === undefined && value.region === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'timeRange or region is required' });
  }
});

export const getPositionAtInputSchema = z.object({
  ...trackletInputBase,
  timestamp: timestampSchema,
  interpolationPolicy: z.enum(['ALLOW_WITHIN_SEQUENCE', 'OBSERVED_ONLY']),
}).strict().superRefine(pinnedSnapshotPolicy);

export const getMotionSummaryInputSchema = z.object({
  ...trackletInputBase,
  timeRange: timeRangeSchema,
  units: z.literal('SI').default('SI'),
  perSequence: z.boolean().default(true),
}).strict().superRefine(pinnedSnapshotPolicy);

export const findStopIntervalsInputSchema = z.object({
  ...trackletInputBase,
  timeRange: timeRangeSchema,
  maximumDiameterMeters: z.number().positive().max(100_000),
  minimumDurationSeconds: z.number().positive().max(86_400),
  limit: z.number().int().min(1).max(1000).default(1000),
}).strict().superRefine(pinnedSnapshotPolicy);

export const findRegionInteractionsInputSchema = z.object({
  ...trackletInputBase,
  region: regionRefSchema,
  timeRange: timeRangeSchema,
  events: z.array(z.enum(['VISIT', 'ENTER', 'EXIT', 'TOUCH', 'CROSS'])).min(1).max(5),
  minimumVisitSeconds: z.number().min(0).max(86_400).default(0),
  boundaryPolicy: z.enum(['REPORT_AMBIGUOUS', 'NOMINAL']).default('REPORT_AMBIGUOUS'),
  limit: z.number().int().min(1).max(1000).default(1000),
}).strict().superRefine(pinnedSnapshotPolicy);

export const findTrackletsInRegionInputSchema = z.object({
  ...commonFields,
  region: regionRefSchema,
  timeRange: timeRangeSchema,
  sourceTypes: z.array(z.string().min(1).max(64)).max(32).default([]),
  mode: z.enum(['CANDIDATE', 'EXACT_VISIT']).default('EXACT_VISIT'),
  limit: z.number().int().min(1).max(5000).default(500),
}).strict().superRefine(pinnedSnapshotPolicy);

export const nearestApproachInputSchema = z.object({
  ...commonFields,
  trackletA: trackletVersionRefSchema,
  trackletB: trackletVersionRefSchema,
  timeRange: timeRangeSchema,
  dimensionPolicy: z.literal('2D'),
  uncertaintyPolicy: z.literal('NOMINAL_WITH_SCALAR_SENSITIVITY').default('NOMINAL_WITH_SCALAR_SENSITIVITY'),
}).strict().superRefine(pinnedSnapshotPolicy);

export const findProximityIntervalsInputSchema = z.object({
  ...commonFields,
  trackletA: trackletVersionRefSchema,
  trackletB: trackletVersionRefSchema,
  timeRange: timeRangeSchema,
  maxDistanceMeters: z.number().positive().max(1_000_000),
  minimumDurationSeconds: z.number().min(0).max(86_400),
  uncertaintyPolicy: z.literal('NOMINAL_WITH_SCALAR_SENSITIVITY').default('NOMINAL_WITH_SCALAR_SENSITIVITY'),
  uncertaintyAlgorithm: z.literal('SCALAR_SENSITIVITY').default('SCALAR_SENSITIVITY'),
  limit: z.number().int().min(1).max(1000).default(1000),
}).strict().superRefine(pinnedSnapshotPolicy);

export const findNearbyTrackletsInputSchema = z.object({
  ...commonFields,
  subject: trackletVersionRefSchema,
  timeRange: timeRangeSchema,
  maxDistanceMeters: z.number().positive().max(1_000_000),
  sourceTypes: z.array(z.string().min(1).max(64)).max(32).default([]),
  mode: z.enum(['CANDIDATE', 'EXACT_EVER']).default('EXACT_EVER'),
  uncertaintyPolicy: z.enum(['NOMINAL', 'CONSERVATIVE_BOUND']).default('NOMINAL'),
  limit: z.number().int().min(1).max(5000).default(500),
}).strict().superRefine(pinnedSnapshotPolicy);

export const findSuccessorCandidatesInputSchema = z.object({
  ...commonFields,
  predecessor: trackletVersionRefSchema,
  maxGapSeconds: z.number().positive().max(86_400),
  maxSpeedMps: z.number().positive().max(10_000),
  maxAccelerationMps2: z.number().positive().max(10_000).optional(),
  maxHeadingDeltaDegrees: z.number().min(0).max(180).optional(),
  reachabilityLevel: z.union([z.literal(1), z.literal(2)]),
  uncertaintyPolicy: z.enum(['NOMINAL', 'CONSERVATIVE_BOUND']).default('NOMINAL'),
  sourceTypes: z.array(z.string().min(1).max(64)).max(32).default([]),
  limit: z.number().int().min(1).max(5000).default(100),
}).strict().superRefine((value, context) => {
  pinnedSnapshotPolicy(value, context);
  if (value.reachabilityLevel === 2
      && (value.maxAccelerationMps2 === undefined || value.maxHeadingDeltaDegrees === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Level 2 requires maxAccelerationMps2 and maxHeadingDeltaDegrees' });
  }
});

const pairFeatureSchema = z.enum([
  'TEMPORAL_OVERLAP',
  'MIN_DISTANCE',
  'PROXIMITY_DURATION',
  'GAP_CONTEXT',
]);

export const comparePairFeaturesInputSchema = z.object({
  ...commonFields,
  trackletA: trackletVersionRefSchema,
  trackletB: trackletVersionRefSchema,
  timeRange: timeRangeSchema,
  features: z.array(pairFeatureSchema).min(1).max(32),
  thresholds: z.object({
    proximityMeters: z.array(z.number().positive().max(1_000_000)).length(1).default([10]),
  }).strict(),
}).strict().superRefine(pinnedSnapshotPolicy);

const queryPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  srid: z.number().int().positive(),
}).strict();

export const findSensorCoverageInputSchema = z.object({
  ...commonFields,
  sensorId: uuidSchema.optional(),
  objectClass: z.string().min(1).max(128).optional(),
  timeRange: timeRangeSchema,
  point: queryPointSchema.optional(),
  spatialObjectVersionId: uuidSchema.optional(),
  includeInactive: z.boolean().default(false),
  limit: z.number().int().min(1).max(1000).default(500),
}).strict().superRefine((value, context) => {
  pinnedSnapshotPolicy(value, context);
  if (value.sensorId === undefined && value.point === undefined && value.spatialObjectVersionId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'sensorId, point, or spatialObjectVersionId is required' });
  }
  if (value.point !== undefined && value.spatialObjectVersionId !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'point and spatialObjectVersionId are mutually exclusive' });
  }
});

export const toolSchemas = {
  get_tracklet: getTrackletInputSchema,
  get_tracklet_gaps: getTrackletGapsInputSchema,
  get_tracklet_quality: getTrackletQualityInputSchema,
  slice_tracklet: sliceTrackletInputSchema,
  get_position_at: getPositionAtInputSchema,
  get_motion_summary: getMotionSummaryInputSchema,
  find_stop_intervals: findStopIntervalsInputSchema,
  find_region_interactions: findRegionInteractionsInputSchema,
  find_tracklets_in_region: findTrackletsInRegionInputSchema,
  nearest_approach: nearestApproachInputSchema,
  find_proximity_intervals: findProximityIntervalsInputSchema,
  find_nearby_tracklets: findNearbyTrackletsInputSchema,
  find_successor_candidates: findSuccessorCandidatesInputSchema,
  compare_pair_features: comparePairFeaturesInputSchema,
  find_sensor_coverage: findSensorCoverageInputSchema,
} as const;

export type ToolName = keyof typeof toolSchemas;
export type ToolInput = Record<string, unknown> & {
  dataScopeId: string;
  deadlineMs?: number;
  evidenceLevel: 'SUMMARY' | 'STANDARD' | 'FULL';
};
