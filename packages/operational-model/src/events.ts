import { z } from "zod";
import type {
  GowmV04OperationalTaskEvent,
  GowmV04CommonReferenceKey,
  GowmV04ExternalCorrelationClaim
} from "../../platform/contract-runtime/src/generated/contracts.js";
import { assertContract } from "../../platform/contract-runtime/src/schema-validator.js";

const REFERENCE_KINDS = [
  "WORLD_OBJECT","SPATIAL_OBJECT","DATA_SCOPE","DATASET","LAYER","LAYER_FEATURE",
  "QUERY_RESULT","DERIVED_REFERENCE","REFERENCE_SET","OPERATIONAL_TASK"
] as const;

export const OPERATIONAL_EVENT_TYPES = [
  "CONTROL_REQUEST_OBSERVED","CONTROL_ACCEPTED_OBSERVED","CONTROL_REJECTED_OBSERVED",
  "EXECUTION_STARTED_OBSERVED","EXECUTION_PROGRESS_OBSERVED","EXECUTION_PAUSED_OBSERVED",
  "EXECUTION_STOPPED_OBSERVED","CONTROL_COMPLETED_REPORTED",
  "PHYSICAL_EFFECT_PARTIALLY_CONFIRMED","PHYSICAL_EFFECT_CONFIRMED",
  "PHYSICAL_EFFECT_CONTRADICTED","EXECUTION_FAILED_OBSERVED",
  "EXECUTION_CANCELLED_OBSERVED","OBSERVATION_GAP_OPENED","OBSERVATION_GAP_CLOSED"
] as const;

const ReferenceKeySchema = z.object({
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

const ExternalCorrelationClaimSchema = z.object({
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
  subjectReferenceKey: ReferenceKeySchema.optional(),
  actorReferenceKeys: z.array(ReferenceKeySchema).max(100),
  targetReferenceKeys: z.array(ReferenceKeySchema).max(100),
  geometryRef: z.string().min(1).max(2048).optional(),
  payload: z.record(z.string(), z.unknown()),
  confidence: z.number().min(0).max(1).optional(),
  provenance: z.array(EvidenceRefSchema).min(1).max(100),
  correlationClaims: z.array(ExternalCorrelationClaimSchema).max(32).optional()
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
export type OperationalReferenceKey = GowmV04CommonReferenceKey;
export type OperationalCorrelationClaim = GowmV04ExternalCorrelationClaim;

export function parseOperationalEventIngest(input: unknown): OperationalEventIngest {
  return OperationalEventIngestSchema.parse(input);
}

export function assertOperationalTaskEvent(event: unknown): asserts event is OperationalTaskEvent {
  assertContract<OperationalTaskEvent>("gowm-v0.4/operational-task-event.schema.json",event);
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
