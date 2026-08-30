import { canonicalSha256 } from "../../historical-trace-core/src/index.js";
import type { Sha256Digest } from "../../historical-trace-model/src/index.js";
import {
  HistoricalProjectionInputError,
  ProjectionFenceLostError,
  errorMessage,
  isoTimestamp,
  optionalString,
  requiredInteger,
  requiredString,
  type SqlExecutor,
  type SqlPool,
  withProjectionTransaction
} from "./database.js";

interface LeaseIdentity {
  queueId: string;
  workerId: string;
  generation: number;
  leaseUntil: string;
}

export interface TrackletProjectionClaim extends LeaseIdentity {
  dataScopeKey: string;
  sourceKey: string;
  sourceLocalTargetId: string;
  trackerSessionKey: string;
  analysisSpaceKey: string;
  profileKey: string;
  desiredInputSetHash: Sha256Digest;
}

export interface TrackletFinalizationClaim extends LeaseIdentity {
  trackletVersionId: string;
  desiredEvidenceHash: Sha256Digest;
  finalizationAsOf: string;
}

export interface WatermarkRevisionEvidence {
  datastreamKey: string;
  watermarkRevisionId: string;
  closedThroughEventTime?: string;
  allowedLateness: string;
  completenessState: string;
  createdAt: string;
}

export interface TrackletFinalizationProfile {
  profileKey: string;
  profileVersion: string;
  profileHash: Sha256Digest;
}

export interface TrackletFinalizationEvidence {
  claim: TrackletFinalizationClaim;
  trackletVersionState: "PROVISIONAL" | "SEALED" | "CONFLICTED";
  trackletEndEventTime: string;
  priorFinalizationState?: "PROVISIONAL" | "SEALED" | "REOPENED" | "CONFLICTED";
  requiredDatastreamKeys: string[];
  watermarkCandidates: WatermarkRevisionEvidence[];
  staleTimeSolutionCount: number;
  activeDirtyCount: number;
  profile: TrackletFinalizationProfile;
}

export type TrackletFinalizationState = "PROVISIONAL" | "SEALED" | "REOPENED" | "CONFLICTED";

export interface TrackletFinalizationDecision {
  state: TrackletFinalizationState;
  observedThrough?: string;
  watermarkInputs: Array<WatermarkRevisionEvidence & { inputNo: number }>;
  reasonCodes: string[];
  contentHash: Sha256Digest;
}

export interface TrackletProjectionRepository {
  claimTracklets(workerId: string, batchSize: number, leaseSeconds: number): Promise<TrackletProjectionClaim[]>;
  rebuildAndComplete(claim: TrackletProjectionClaim): Promise<string>;
  failTracklet(claim: TrackletProjectionClaim, error: unknown, retryAt: string): Promise<boolean>;
  claimFinalizations(workerId: string, batchSize: number, leaseSeconds: number): Promise<TrackletFinalizationClaim[]>;
  loadFinalization(claim: TrackletFinalizationClaim): Promise<TrackletFinalizationEvidence>;
  finalizeAndComplete(evidence: TrackletFinalizationEvidence): Promise<{ revisionId: string; decision: TrackletFinalizationDecision }>;
  failFinalization(claim: TrackletFinalizationClaim, error: unknown, retryAt: string): Promise<boolean>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function time(value: string, field = "timestamp"): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new HistoricalProjectionInputError(`${field} is invalid`);
  return parsed;
}

/** Selects one immutable watermark revision per stream at a fixed as-of boundary. */
export function selectWatermarkRevisionsAsOf(
  candidates: readonly WatermarkRevisionEvidence[],
  finalizationAsOf: string
): WatermarkRevisionEvidence[] {
  const cutoff = time(finalizationAsOf, "finalizationAsOf");
  const selected = new Map<string, WatermarkRevisionEvidence>();
  for (const candidate of candidates) {
    const created = time(candidate.createdAt, "watermark createdAt");
    if (created > cutoff) continue;
    const current = selected.get(candidate.datastreamKey);
    if (current === undefined
        || created > time(current.createdAt)
        || (created === time(current.createdAt)
          && compareText(candidate.watermarkRevisionId, current.watermarkRevisionId) > 0)) {
      selected.set(candidate.datastreamKey, candidate);
    }
  }
  return [...selected.values()].sort((left, right) => compareText(left.datastreamKey, right.datastreamKey));
}

function provisionalState(prior: TrackletFinalizationEvidence["priorFinalizationState"]): "PROVISIONAL" | "REOPENED" {
  return prior === "SEALED" ? "REOPENED" : "PROVISIONAL";
}

export function evaluateTrackletFinalization(evidence: TrackletFinalizationEvidence): TrackletFinalizationDecision {
  const selected = selectWatermarkRevisionsAsOf(evidence.watermarkCandidates, evidence.claim.finalizationAsOf);
  const byStream = new Map(selected.map((item) => [item.datastreamKey, item]));
  const reasonCodes: string[] = [];
  let state: TrackletFinalizationState;

  if (evidence.trackletVersionState === "CONFLICTED") {
    state = "CONFLICTED";
    reasonCodes.push("TRACKLET_CONFLICTED");
  } else {
    for (const stream of [...new Set(evidence.requiredDatastreamKeys)].sort(compareText)) {
      const watermark = byStream.get(stream);
      if (watermark === undefined) reasonCodes.push("WATERMARK_MISSING");
      else {
        if (watermark.completenessState !== "COMPLETE") reasonCodes.push("WATERMARK_INCOMPLETE");
        if (watermark.closedThroughEventTime === undefined
            || time(watermark.closedThroughEventTime) < time(evidence.trackletEndEventTime)) {
          reasonCodes.push("WATERMARK_BEHIND_TRACKLET");
        }
      }
    }
    if (evidence.staleTimeSolutionCount > 0) reasonCodes.push("TIME_SOLUTION_SUPERSEDED");
    if (evidence.activeDirtyCount > 0) reasonCodes.push("TRACKLET_REBUILD_PENDING");
    if (evidence.requiredDatastreamKeys.length === 0) reasonCodes.push("WATERMARK_MISSING");
    if (reasonCodes.length === 0) {
      state = "SEALED";
      reasonCodes.push("WATERMARKS_COMPLETE");
    } else {
      state = provisionalState(evidence.priorFinalizationState);
    }
  }

  const closed = selected
    .map((item) => item.closedThroughEventTime)
    .filter((value): value is string => value !== undefined)
    .sort((left, right) => time(left) - time(right));
  const observedThrough = closed.length === selected.length && closed.length > 0 ? closed[0] : undefined;
  const watermarkInputs = selected.map((item, index) => ({ ...item, inputNo: index + 1 }));
  const canonical = {
    trackletVersionId: evidence.claim.trackletVersionId,
    finalizationAsOf: new Date(time(evidence.claim.finalizationAsOf)).toISOString(),
    state,
    ...(observedThrough === undefined ? {} : { observedThrough: new Date(time(observedThrough)).toISOString() }),
    watermarkInputs,
    reasonCodes: [...new Set(reasonCodes)].sort(compareText),
    profile: evidence.profile
  };
  return {
    state,
    ...(observedThrough === undefined ? {} : { observedThrough: new Date(time(observedThrough)).toISOString() }),
    watermarkInputs,
    reasonCodes: canonical.reasonCodes,
    contentHash: canonicalSha256(canonical)
  };
}

interface TrackletQueueRow extends Record<string, unknown> {
  queue_id: unknown;
  data_scope_key: unknown;
  source_key: unknown;
  source_local_target_id: unknown;
  tracker_session_key: unknown;
  analysis_space_key: unknown;
  profile_key: unknown;
  desired_input_set_hash: unknown;
  generation: unknown;
  lease_until: unknown;
}

interface FinalizationQueueRow extends Record<string, unknown> {
  queue_id: unknown;
  tracklet_version_id: unknown;
  desired_evidence_hash: unknown;
  finalization_as_of: unknown;
  generation: unknown;
  lease_until: unknown;
}

function digest(value: unknown, field: string): Sha256Digest {
  const result = requiredString(value, field);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new HistoricalProjectionInputError(`${field} is not SHA-256`);
  return result as Sha256Digest;
}

function trackletClaim(row: TrackletQueueRow, workerId: string): TrackletProjectionClaim {
  return {
    queueId: requiredString(row.queue_id, "queue_id"),
    workerId,
    generation: requiredInteger(row.generation, "generation"),
    leaseUntil: isoTimestamp(row.lease_until, "lease_until"),
    dataScopeKey: requiredString(row.data_scope_key, "data_scope_key"),
    sourceKey: requiredString(row.source_key, "source_key"),
    sourceLocalTargetId: requiredString(row.source_local_target_id, "source_local_target_id"),
    trackerSessionKey: requiredString(row.tracker_session_key, "tracker_session_key"),
    analysisSpaceKey: requiredString(row.analysis_space_key, "analysis_space_key"),
    profileKey: requiredString(row.profile_key, "profile_key"),
    desiredInputSetHash: digest(row.desired_input_set_hash, "desired_input_set_hash")
  };
}

function finalizationClaim(row: FinalizationQueueRow, workerId: string): TrackletFinalizationClaim {
  return {
    queueId: requiredString(row.queue_id, "queue_id"),
    workerId,
    generation: requiredInteger(row.generation, "generation"),
    leaseUntil: isoTimestamp(row.lease_until, "lease_until"),
    trackletVersionId: requiredString(row.tracklet_version_id, "tracklet_version_id"),
    desiredEvidenceHash: digest(row.desired_evidence_hash, "desired_evidence_hash"),
    finalizationAsOf: isoTimestamp(row.finalization_as_of, "finalization_as_of")
  };
}

async function booleanCas(
  connection: SqlExecutor,
  sql: string,
  values: readonly unknown[],
  field: string
): Promise<void> {
  const result = await connection.query<Record<string, unknown>>(sql, values);
  if (result.rows[0]?.[field] !== true) throw new ProjectionFenceLostError();
}

export class PostgresTrackletProjectionRepository implements TrackletProjectionRepository {
  public constructor(private readonly pool: SqlPool) {}

  public async claimTracklets(workerId: string, batchSize: number, leaseSeconds: number): Promise<TrackletProjectionClaim[]> {
    const result = await this.pool.query<TrackletQueueRow>(`
      SELECT * FROM gowm_history.claim_tracklet_projection(
        $1::text, $2::integer, make_interval(secs => $3::double precision)
      )
    `, [workerId, batchSize, leaseSeconds]);
    return result.rows.map((row) => trackletClaim(row, workerId));
  }

  public async rebuildAndComplete(claim: TrackletProjectionClaim): Promise<string> {
    return withProjectionTransaction(this.pool, async (connection) => {
      const rebuilt = await connection.query<{ tracklet_version_id: unknown }>(`
        SELECT gowm_history.rebuild_mobility_tracklet_v2(
          $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, false
        ) AS tracklet_version_id
      `, [
        claim.dataScopeKey, claim.sourceKey, claim.sourceLocalTargetId,
        claim.trackerSessionKey, claim.analysisSpaceKey, claim.profileKey
      ]);
      const versionId = requiredString(rebuilt.rows[0]?.tracklet_version_id, "tracklet_version_id");
      await booleanCas(connection, `
        SELECT gowm_history.complete_tracklet_projection(
          $1::uuid, $2::text, $3::bigint, $4::uuid
        ) AS completed
      `, [claim.queueId, claim.workerId, claim.generation, versionId], "completed");
      return versionId;
    });
  }

  public async failTracklet(claim: TrackletProjectionClaim, error: unknown, retryAt: string): Promise<boolean> {
    const result = await this.pool.query<{ failed: unknown }>(`
      SELECT gowm_history.fail_tracklet_projection(
        $1::uuid, $2::text, $3::bigint, $4::text, $5::timestamptz
      ) AS failed
    `, [claim.queueId, claim.workerId, claim.generation, errorMessage(error), retryAt]);
    return result.rows[0]?.failed === true;
  }

  public async claimFinalizations(workerId: string, batchSize: number, leaseSeconds: number): Promise<TrackletFinalizationClaim[]> {
    const result = await this.pool.query<FinalizationQueueRow>(`
      SELECT * FROM gowm_history.claim_tracklet_finalization(
        $1::text, $2::integer, make_interval(secs => $3::double precision)
      )
    `, [workerId, batchSize, leaseSeconds]);
    return result.rows.map((row) => finalizationClaim(row, workerId));
  }

  public async loadFinalization(claim: TrackletFinalizationClaim): Promise<TrackletFinalizationEvidence> {
    const summary = await this.pool.query<Record<string, unknown>>(`
      SELECT version.version_state, version.end_event_time,
             prior.finalization_state AS prior_finalization_state,
             (SELECT count(*) FROM public.mobility_tracklet_input input
              WHERE input.tracklet_version_id = version.tracklet_version_id
                AND EXISTS (
                  SELECT 1 FROM public.observation_time_solution successor
                  WHERE successor.supersedes_time_solution_id = input.time_solution_id
                    AND successor.created_at <= $2::timestamptz
                )) AS stale_time_solution_count,
             (SELECT count(*) FROM gowm_history.tracklet_projection_queue queue
              WHERE queue.data_scope_key = tracklet.data_scope_key
                AND queue.source_key = tracklet.source_key
                AND queue.source_local_target_id = tracklet.source_local_target_id
                AND queue.tracker_session_key = tracklet.tracker_session_key
                AND queue.analysis_space_key = tracklet.analysis_space_key
                AND queue.profile_key = version.profile_key
                AND queue.created_at <= $2::timestamptz
                AND queue.state IN ('QUEUED','RUNNING','FAILED')
                AND queue.rebuilt_tracklet_version_id IS DISTINCT FROM version.tracklet_version_id
             ) AS active_dirty_count
      FROM public.mobility_tracklet_version version
      JOIN public.mobility_tracklet tracklet USING (tracklet_id)
      LEFT JOIN gowm_history.tracklet_finalization_head head
        ON head.tracklet_version_id = version.tracklet_version_id
      LEFT JOIN gowm_history.tracklet_finalization_revision prior
        ON prior.finalization_revision_id = head.current_finalization_revision_id
      WHERE version.tracklet_version_id = $1::uuid
    `, [claim.trackletVersionId, claim.finalizationAsOf]);
    const row = summary.rows[0];
    if (row === undefined) throw new HistoricalProjectionInputError("tracklet version is unavailable");

    const streams = await this.pool.query<Record<string, unknown>>(`
      SELECT DISTINCT observation.datastream_key
      FROM public.mobility_tracklet_input input
      JOIN public.world_observation observation
        ON observation.observation_id = input.observation_id
      WHERE input.tracklet_version_id = $1::uuid
      ORDER BY observation.datastream_key
    `, [claim.trackletVersionId]);
    const requiredDatastreamKeys = streams.rows.map((item) => requiredString(item.datastream_key, "datastream_key"));

    const watermarks = await this.pool.query<Record<string, unknown>>(`
      SELECT watermark.datastream_key, watermark.watermark_revision_id,
             CASE WHEN watermark.closed_through_event_time IS NULL THEN NULL
               ELSE to_char(watermark.closed_through_event_time AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             END AS closed_through_event_time,
             watermark.allowed_lateness::text AS allowed_lateness,
             watermark.completeness_state,
             to_char(watermark.created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM public.pipeline_watermark_revision watermark
      WHERE watermark.datastream_key = ANY($1::text[])
        AND watermark.created_at <= $2::timestamptz
      ORDER BY watermark.datastream_key, watermark.created_at,
               watermark.watermark_revision_id
    `, [requiredDatastreamKeys, claim.finalizationAsOf]);
    const watermarkCandidates = watermarks.rows.map((item): WatermarkRevisionEvidence => {
      const closed = item.closed_through_event_time;
      return {
        datastreamKey: requiredString(item.datastream_key, "datastream_key"),
        watermarkRevisionId: requiredString(item.watermark_revision_id, "watermark_revision_id"),
        ...(closed === null || closed === undefined
          ? {}
          : { closedThroughEventTime: requiredString(closed, "closed_through_event_time") }),
        allowedLateness: requiredString(item.allowed_lateness, "allowed_lateness"),
        completenessState: requiredString(item.completeness_state, "completeness_state"),
        createdAt: requiredString(item.created_at, "watermark created_at")
      };
    });

    const profiles = await this.pool.query<Record<string, unknown>>(`
      SELECT profile_key, profile_version, content_hash
      FROM gowm_history.method_profile
      WHERE profile_key = 'tracklet-finalization-watermark-v1'
        AND profile_kind = 'TRACKLET_FINALIZATION'
      ORDER BY created_at DESC LIMIT 1
    `);
    const profile = profiles.rows[0];
    if (profile === undefined) throw new HistoricalProjectionInputError("tracklet finalization profile is unavailable");
    const state = requiredString(row.version_state, "version_state");
    if (state !== "PROVISIONAL" && state !== "SEALED" && state !== "CONFLICTED") {
      throw new HistoricalProjectionInputError("tracklet version state is invalid");
    }
    const prior = optionalString(row.prior_finalization_state);
    if (prior !== undefined && prior !== "PROVISIONAL" && prior !== "SEALED" && prior !== "REOPENED" && prior !== "CONFLICTED") {
      throw new HistoricalProjectionInputError("prior finalization state is invalid");
    }
    return {
      claim,
      trackletVersionState: state,
      trackletEndEventTime: isoTimestamp(row.end_event_time, "end_event_time"),
      ...(prior === undefined ? {} : { priorFinalizationState: prior }),
      requiredDatastreamKeys,
      watermarkCandidates,
      staleTimeSolutionCount: requiredInteger(row.stale_time_solution_count, "stale_time_solution_count"),
      activeDirtyCount: requiredInteger(row.active_dirty_count, "active_dirty_count"),
      profile: {
        profileKey: requiredString(profile.profile_key, "profile_key"),
        profileVersion: requiredString(profile.profile_version, "profile_version"),
        profileHash: digest(profile.content_hash, "profile content_hash")
      }
    };
  }

  public async finalizeAndComplete(
    evidence: TrackletFinalizationEvidence
  ): Promise<{ revisionId: string; decision: TrackletFinalizationDecision }> {
    const decision = evaluateTrackletFinalization(evidence);
    return withProjectionTransaction(this.pool, async (connection) => {
      const hash = await connection.query<{ watermark_set_hash: unknown }>(`
        SELECT public.grounding_sha256(COALESCE(jsonb_agg(jsonb_build_array(
          (item->>'inputNo')::integer,
          item->>'datastreamKey',
          (item->>'watermarkRevisionId')::uuid,
          NULLIF(item->>'closedThroughEventTime', '')::timestamptz,
          (item->>'allowedLateness')::interval,
          item->>'completenessState',
          (item->>'createdAt')::timestamptz
        ) ORDER BY (item->>'inputNo')::integer)::text, '[]')) AS watermark_set_hash
        FROM jsonb_array_elements($1::jsonb) item
      `, [JSON.stringify(decision.watermarkInputs)]);
      const watermarkSetHash = requiredString(hash.rows[0]?.watermark_set_hash, "watermark_set_hash");
      const current = await connection.query<{ current_revision_id: unknown }>(`
        SELECT head.current_finalization_revision_id AS current_revision_id
        FROM gowm_history.tracklet_finalization_head head
        WHERE head.tracklet_version_id = $1::uuid
      `, [evidence.claim.trackletVersionId]);
      const supersedes = optionalString(current.rows[0]?.current_revision_id);
      const registered = await connection.query<{ revision_id: unknown }>(`
        SELECT gowm_history.register_tracklet_finalization_revision(
          $1::uuid, $2::text, $3::timestamptz, $4::timestamptz,
          $5::text, $6::text, $7::text, $8::text, $9::text[],
          $10::text, $11::uuid, $12::jsonb
        ) AS revision_id
      `, [
        evidence.claim.trackletVersionId,
        decision.state,
        evidence.claim.finalizationAsOf,
        decision.observedThrough ?? null,
        evidence.profile.profileKey,
        evidence.profile.profileVersion,
        evidence.profile.profileHash,
        watermarkSetHash,
        decision.reasonCodes,
        decision.contentHash,
        supersedes ?? null,
        JSON.stringify(decision.watermarkInputs.map((item) => ({
          inputNo: item.inputNo,
          datastreamKey: item.datastreamKey,
          watermarkRevisionId: item.watermarkRevisionId,
          closedThroughEventTime: item.closedThroughEventTime ?? "",
          allowedLateness: item.allowedLateness,
          completenessState: item.completenessState,
          watermarkCreatedAt: item.createdAt
        })))
      ]);
      const revisionId = requiredString(registered.rows[0]?.revision_id, "finalization revision_id");
      await booleanCas(connection, `
        SELECT gowm_history.complete_tracklet_finalization(
          $1::uuid, $2::text, $3::bigint, $4::uuid
        ) AS completed
      `, [
        evidence.claim.queueId, evidence.claim.workerId,
        evidence.claim.generation, revisionId
      ], "completed");
      return { revisionId, decision };
    });
  }

  public async failFinalization(claim: TrackletFinalizationClaim, error: unknown, retryAt: string): Promise<boolean> {
    const result = await this.pool.query<{ failed: unknown }>(`
      SELECT gowm_history.fail_tracklet_finalization(
        $1::uuid, $2::text, $3::bigint, $4::text, $5::timestamptz
      ) AS failed
    `, [claim.queueId, claim.workerId, claim.generation, errorMessage(error), retryAt]);
    return result.rows[0]?.failed === true;
  }
}
