import { z } from "zod";
import type {
  GowmV04OperationalTaskEvent,
  GowmV04OperationalTaskSnapshot,
  GowmV04CorrelationFinding,
  GowmV04OperationalEventTimeline,
  GowmV04OperationalQueryResult,
  GowmV04CommonReferenceKey,
  GowmV04ExternalCorrelationClaim,
  GowmV04ExternalPredicate,
  GowmV04PredicateEvaluation,
  GowmV04ObservabilityAssessment
} from "../../platform/contract-runtime/src/generated/contracts.js";
import { assertContract } from "../../platform/contract-runtime/src/schema-validator.js";

const REFERENCE_KINDS = [
  "WORLD_OBJECT","SPATIAL_OBJECT","DATA_SCOPE","DATASET","LAYER","LAYER_FEATURE",
  "QUERY_RESULT","DERIVED_REFERENCE","REFERENCE_SET","OPERATIONAL_TASK"
] as const;

export const OPERATIONAL_EVENT_TYPES = [
  "CONTROL_REQUEST_OBSERVED","CONTROL_ACCEPTED_OBSERVED","CONTROL_REJECTED_OBSERVED",
  "EXECUTION_STARTED_OBSERVED","EXECUTION_PROGRESS_OBSERVED","EXECUTION_PAUSED_OBSERVED",
  "EXECUTION_RESUMED_OBSERVED","EXECUTION_STOPPED_OBSERVED","CONTROL_COMPLETED_REPORTED",
  "PHYSICAL_EFFECT_PARTIALLY_CONFIRMED","PHYSICAL_EFFECT_CONFIRMED",
  "PHYSICAL_EFFECT_CONTRADICTED","EXECUTION_FAILED_OBSERVED",
  "EXECUTION_CANCELLED_OBSERVED","OBSERVATION_GAP_OPENED","OBSERVATION_GAP_CLOSED"
] as const;

export const OperationalReferenceKeySchema = z.object({
  namespace: z.literal("gowm"),
  kind: z.enum(REFERENCE_KINDS),
  id: z.string().regex(/^wrf_[0-9a-f]{32}$/u),
  version: z.string().min(1).max(128)
}).strict();

const EvidenceRefSchema = z.object({
  evidenceId: z.string().min(1).max(256),
  authority: z.string().min(1).max(128),
  evidenceType: z.string().min(1).max(128),
  worldVersion: z.number().int().nonnegative().optional(),
  observedAt: z.iso.datetime({ offset: true }).optional()
}).strict();

export const OperationalCorrelationClaimSchema = z.object({
  claimId: z.string().min(1),
  externalAuthority: z.string().min(1),
  externalKind: z.enum([
    "PLANNING_TASK","PLANNING_STEP","EXECUTION_INTENT","OPERATION_CORRELATION",
    "PROVIDER_ACTION","DEVICE_COMMAND"
  ]),
  externalValue: z.string().min(1).max(512),
  relationHint: z.enum(["REPORTS_EXECUTION_OF","REALIZES","RELATED_TO"]).optional(),
  matchBasis: z.enum([
    "PROPAGATED_CORRELATION_ID","PROVIDER_DECLARED","MANUAL_CONFIRMATION",
    "RESOURCE_AND_TIME_MATCH","SPATIOTEMPORAL_INFERENCE"
  ]),
  confidence: z.number().min(0).max(1).optional(),
  observedAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  evidenceIds: z.array(z.string()).max(100)
}).strict();

export const OperationalEventIngestSchema = z.object({
  dataScopeKey: z.string().min(1).max(256),
  sourceAuthority: z.string().min(1).max(128),
  sourceEventKey: z.string().min(1).max(256),
  sourceRevisionNo: z.number().int().positive(),
  eventId: z.string().min(1).max(256),
  operationalTaskId: z.string().min(1).max(256),
  eventType: z.enum(OPERATIONAL_EVENT_TYPES),
  eventTime: z.iso.datetime({ offset: true }),
  subjectReferenceKey: OperationalReferenceKeySchema.optional(),
  actorReferenceKeys: z.array(OperationalReferenceKeySchema).max(100),
  targetReferenceKeys: z.array(OperationalReferenceKeySchema).max(100),
  geometryRef: z.string().min(1).max(2048).optional(),
  payload: z.record(z.string(), z.unknown()),
  confidence: z.number().min(0).max(1).optional(),
  provenance: z.array(EvidenceRefSchema).min(1).max(100),
  correlationClaims: z.array(OperationalCorrelationClaimSchema).max(32).optional()
}).strict().superRefine((event, context) => {
  for (const claim of event.correlationClaims ?? []) {
    if (claim.externalValue === event.operationalTaskId) {
      context.addIssue({
        code: "custom",
        path: ["operationalTaskId"],
        message: "operationalTaskId must not be an external correlation value"
      });
      break;
    }
  }
});

export type OperationalEventIngest = z.infer<typeof OperationalEventIngestSchema>;
export type OperationalTaskEvent = GowmV04OperationalTaskEvent;
export type OperationalTaskSnapshot = GowmV04OperationalTaskSnapshot;
export type CorrelationFinding = GowmV04CorrelationFinding;
export type OperationalEventTimeline = GowmV04OperationalEventTimeline;
export type OperationalQueryResult = GowmV04OperationalQueryResult;
export type OperationalReferenceKey = GowmV04CommonReferenceKey;
export type OperationalCorrelationClaim = GowmV04ExternalCorrelationClaim;
export type ExternalPredicate = GowmV04ExternalPredicate;
export type PredicateEvaluation = GowmV04PredicateEvaluation;
export type ObservabilityAssessment = GowmV04ObservabilityAssessment;

export function parseOperationalEventIngest(input: unknown): OperationalEventIngest {
  return OperationalEventIngestSchema.parse(input);
}

export function assertOperationalTaskEvent(event: unknown): asserts event is OperationalTaskEvent {
  assertContract<OperationalTaskEvent>("gowm-v0.4/operational-task-event.schema.json",event);
}

export function assertOperationalTaskSnapshot(snapshot: unknown): asserts snapshot is OperationalTaskSnapshot {
  assertContract<OperationalTaskSnapshot>("gowm-v0.4/operational-task-snapshot.schema.json",snapshot);
}

export const CorrelationResolveInputSchema = z.object({
  dataScopeKey: z.string().min(1).max(256),
  correlationHint: OperationalCorrelationClaimSchema,
  actorReferenceKeys: z.array(OperationalReferenceKeySchema).max(100).default([]),
  timeRange: z.object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional()
  }).strict().refine((range) => !range.from || !range.to || Date.parse(range.to)>=Date.parse(range.from), {
    message: "timeRange.to must not precede timeRange.from"
  }).optional()
}).strict();

export type CorrelationResolveInput = z.infer<typeof CorrelationResolveInputSchema>;

export function assertCorrelationFinding(finding: unknown): asserts finding is CorrelationFinding {
  assertContract<CorrelationFinding>("gowm-v0.4/correlation-finding.schema.json",finding);
}

export function assertOperationalEventTimeline(timeline: unknown): asserts timeline is OperationalEventTimeline {
  assertContract<OperationalEventTimeline>("gowm-v0.4/operational-event-timeline.schema.json",timeline);
}

export function assertOperationalQueryResult(result: unknown): asserts result is OperationalQueryResult {
  assertContract<OperationalQueryResult>("gowm-v0.4/operational-query-result.schema.json",result);
}

export function assertExternalPredicate(predicate: unknown): asserts predicate is ExternalPredicate {
  assertContract<ExternalPredicate>("gowm-v0.4/external-predicate.schema.json",predicate);
}

export function assertPredicateEvaluation(evaluation: unknown): asserts evaluation is PredicateEvaluation {
  assertContract<PredicateEvaluation>("gowm-v0.4/predicate-evaluation.schema.json",evaluation);
}

export const ObservabilityRequestSchema = z.object({
  dataScopeKey: z.string().min(1).max(256),
  subjectReferenceKey: OperationalReferenceKeySchema,
  timeRange: z.object({
    from: z.iso.datetime({ offset: true }),to: z.iso.datetime({ offset: true })
  }).strict().refine((range) => Date.parse(range.to)>Date.parse(range.from),{
    message: "timeRange.to must follow timeRange.from"
  }),
  expectedSources: z.array(z.string().min(1).max(128)).min(1).max(100),
  freshnessSlaSeconds: z.number().int().positive().max(86_400).default(300)
}).strict();

export type ObservabilityRequest = z.infer<typeof ObservabilityRequestSchema>;

export function assertObservabilityAssessment(assessment: unknown): asserts assessment is ObservabilityAssessment {
  assertContract<ObservabilityAssessment>("gowm-v0.4/observability-assessment.schema.json",assessment);
}

export function validateOperationalEventTime(
  eventTime: string,
  receivedTime: string,
  maxFutureSkewMs: number,
  maxLateArrivalMs: number
): "CURRENT" | "LATE" {
  const eventMs = Date.parse(eventTime);
  const receivedMs = Date.parse(receivedTime);
  if (!Number.isFinite(eventMs) || !Number.isFinite(receivedMs)) throw new Error("invalid operational event timestamp");
  if (eventMs > receivedMs + maxFutureSkewMs) throw new Error("operational event exceeds future-skew policy");
  return receivedMs - eventMs > maxLateArrivalMs ? "LATE" : "CURRENT";
}
