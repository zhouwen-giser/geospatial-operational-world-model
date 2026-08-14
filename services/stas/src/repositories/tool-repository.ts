import type { QueryResultRow } from 'pg';
import type { z } from 'zod';
import type { Transaction } from '../db/database.js';
import type { AnalysisResult, RepositoryExecution, TimeRange, UncertaintyStatement } from '../domain/analysis.js';
import { AppError } from '../domain/errors.js';
import { semanticAnalysisHash } from '../domain/canonical-json.js';
import {
  comparePairFeaturesInputSchema,
  findNearbyTrackletsInputSchema,
  findProximityIntervalsInputSchema,
  findRegionInteractionsInputSchema,
  findSensorCoverageInputSchema,
  findStopIntervalsInputSchema,
  findSuccessorCandidatesInputSchema,
  findTrackletsInRegionInputSchema,
  getMotionSummaryInputSchema,
  getPositionAtInputSchema,
  getTrackletGapsInputSchema,
  getTrackletInputSchema,
  getTrackletQualityInputSchema,
  nearestApproachInputSchema,
  sliceTrackletInputSchema,
  type ToolInput,
  type ToolName,
} from '../tools/schemas.js';

type GetTrackletInput = z.infer<typeof getTrackletInputSchema>;
type GetTrackletGapsInput = z.infer<typeof getTrackletGapsInputSchema>;
type GetTrackletQualityInput = z.infer<typeof getTrackletQualityInputSchema>;
type SliceTrackletInput = z.infer<typeof sliceTrackletInputSchema>;
type GetPositionAtInput = z.infer<typeof getPositionAtInputSchema>;
type GetMotionSummaryInput = z.infer<typeof getMotionSummaryInputSchema>;
type FindStopIntervalsInput = z.infer<typeof findStopIntervalsInputSchema>;
type FindRegionInteractionsInput = z.infer<typeof findRegionInteractionsInputSchema>;
type FindTrackletsInRegionInput = z.infer<typeof findTrackletsInRegionInputSchema>;
type NearestApproachInput = z.infer<typeof nearestApproachInputSchema>;
type FindProximityIntervalsInput = z.infer<typeof findProximityIntervalsInputSchema>;
type FindNearbyTrackletsInput = z.infer<typeof findNearbyTrackletsInputSchema>;
type FindSuccessorCandidatesInput = z.infer<typeof findSuccessorCandidatesInputSchema>;
type ComparePairFeaturesInput = z.infer<typeof comparePairFeaturesInputSchema>;
type FindSensorCoverageInput = z.infer<typeof findSensorCoverageInputSchema>;

interface ResolvedTracklet extends QueryResultRow {
  tracklet_id: string;
  tracklet_version_id: string;
  version_no: number;
  analysis_space_id: string;
  source_id: string;
  source_type: string;
  interpolation: string;
  max_accuracy_radius_m: number | null;
}

interface ResolvedRegion extends QueryResultRow {
  spatial_object_id: string;
  spatial_object_version_id: string;
  analysis_space_id: string;
}

interface VersionRef {
  trackletId: string;
  trackletVersionId?: string;
  versionNo?: number;
}

function toMobilitySpan(range: TimeRange): string {
  return `[${range.start},${range.end})`;
}

function baseSnapshot(versions: ResolvedTracklet[]): RepositoryExecution['snapshot'] {
  return {
    trackletVersions: versions.map((version) => ({
      trackletId: version.tracklet_id,
      trackletVersionId: version.tracklet_version_id,
      versionNo: version.version_no,
    })),
  };
}

function subject(version: ResolvedTracklet): { kind: string; id: string; version: number } {
  return { kind: 'TRACKLET', id: version.tracklet_id, version: version.version_no };
}

function conservativeDistanceUncertainty(
  nominalDistance: number | null,
  versionA: ResolvedTracklet,
  versionB: ResolvedTracklet,
): UncertaintyStatement[] {
  if (nominalDistance === null) return [];
  const radiusA = versionA.max_accuracy_radius_m;
  const radiusB = versionB.max_accuracy_radius_m;
  if (radiusA === null || radiusB === null) {
    return [{
      quantity: 'DISTANCE',
      model: 'UNKNOWN',
      conclusion: 'INDETERMINATE: one or both hard position-error bounds are unavailable',
    }];
  }
  return [{
    quantity: 'DISTANCE',
    model: 'HARD_RADIUS',
    unit: 'm',
    value: {
      nominal: nominalDistance,
      lower: Math.max(0, nominalDistance - radiusA - radiusB),
      upper: nominalDistance + radiusA + radiusB,
      radiusA,
      radiusB,
    },
    conclusion: 'SCALAR_SENSITIVITY_ONLY',
  }];
}

function assertSameAnalysisSpace(a: ResolvedTracklet, b: ResolvedTracklet): void {
  if (a.analysis_space_id !== b.analysis_space_id) {
    throw new AppError('CRS_MISMATCH', 422, 'Analysis spaces differ', 'Both tracklet versions must be published in the same metric analysis space.');
  }
}

function assertTrackletRegionAnalysisSpace(tracklet: ResolvedTracklet, region: ResolvedRegion): void {
  if (tracklet.analysis_space_id !== region.analysis_space_id) {
    throw new AppError('CRS_MISMATCH', 422, 'Analysis spaces differ', 'The tracklet version and spatial object version must be published in the same metric analysis space.');
  }
}

export class ToolRepository {
  public async persistAnalysisRecord(result: AnalysisResult<unknown>, transaction: Transaction): Promise<string> {
    const frozenSnapshot = { ...result.snapshot, databaseSnapshotId: undefined };
    const snapshotHash = semanticAnalysisHash({
      query: result.query,
      snapshot: frozenSnapshot,
      method: {
        tool: result.method.tool,
        toolVersion: result.method.toolVersion,
        algorithm: result.method.algorithm,
        algorithmVersion: result.method.algorithmVersion,
        interpolationPolicy: result.method.interpolationPolicy,
        uncertaintyPolicy: result.method.uncertaintyPolicy,
        metricDimension: result.method.metricDimension,
        sqlTemplateHash: result.method.sqlTemplateHash,
      },
    });
    const persisted = await transaction.query<{ analysis_id: string }>(`
      INSERT INTO stas.analysis_record
        (analysis_id,data_scope_key,status,tool_name,tool_version,algorithm,algorithm_version,
         analysis_as_of,query_payload,result_payload,method_snapshot,snapshot_hash)
      SELECT $1::uuid,d.tenant_key,$3,$4,$5,$6,$7,$8::timestamptz,$9::jsonb,$10::jsonb,$11::jsonb,$12
      FROM gowm_stas_v1.data_scope d WHERE d.data_scope_id=$2::uuid
      RETURNING analysis_id
    `, [
      result.analysisId, result.snapshot.dataScopeId, result.status, result.method.tool,
      result.method.toolVersion, result.method.algorithm, result.method.algorithmVersion,
      result.generatedAt, JSON.stringify(result.query), JSON.stringify({
        status: result.status, subjects: result.subjects, result: result.result,
        coverage: result.coverage, evidence: result.evidence, gaps: result.gaps,
        uncertainties: result.uncertainties, assumptions: result.assumptions,
        sourceReferences: result.sourceReferences, quality: result.quality,
        warnings: result.warnings, page: result.page, execution: result.execution,
      }), JSON.stringify({ method: result.method, snapshot: frozenSnapshot }), snapshotHash,
    ]);
    const persistedAnalysisId = persisted.rows[0]?.analysis_id;
    if (persistedAnalysisId === undefined) throw new AppError('INTERNAL_ERROR', 500, 'Analysis persistence failed', 'No AnalysisRecord identifier was returned.');
    if (result.snapshot.trackletVersions.length > 0) {
      await transaction.query(`
        INSERT INTO stas.analysis_tracklet_input(analysis_id,tracklet_version_id,input_role)
        SELECT $1::uuid,u.id,('TRACKLET_'||u.ordinality)::text
        FROM unnest($2::uuid[]) WITH ORDINALITY AS u(id,ordinality)
      `, [result.analysisId, [...new Set(result.snapshot.trackletVersions.map((item) => item.trackletVersionId))]]);
    }
    const simpleInputs: Array<{ table: string; column: string; ids: string[] | undefined; role: string }> = [
      { table: 'analysis_time_solution_input', column: 'time_solution_id', ids: result.snapshot.timeSolutionIds, role: 'TIME_SOLUTION' },
      { table: 'analysis_clock_model_input', column: 'clock_model_id', ids: result.snapshot.clockModelIds, role: 'CLOCK_MODEL' },
      { table: 'analysis_spatial_object_input', column: 'spatial_object_version_id', ids: result.snapshot.spatialObjectVersionIds, role: 'SPATIAL_OBJECT' },
      { table: 'analysis_quality_input', column: 'source_reliability_profile_id', ids: result.snapshot.sourceReliabilityProfileIds, role: 'QUALITY_PROFILE' },
    ];
    for (const item of simpleInputs) {
      if (item.ids !== undefined && item.ids.length > 0) {
        // Table/column names are internal constants, never request data.
        await transaction.query(`
          INSERT INTO stas.${item.table}(analysis_id,${item.column},input_role)
          SELECT $1::uuid,u.id,($3||'_'||u.ordinality)::text
          FROM unnest($2::uuid[]) WITH ORDINALITY AS u(id,ordinality)
        `, [result.analysisId, [...new Set(item.ids)], item.role]);
      }
    }
    const coverageInputs: Array<{ column: string; ids: string[] | undefined; role: string }> = [
      { column: 'coverage_slice_id', ids: result.snapshot.coverageSliceIds, role: 'COVERAGE_SLICE' },
      { column: 'sensor_pose_version_id', ids: result.snapshot.sensorPoseVersionIds, role: 'SENSOR_POSE' },
      { column: 'sensor_extrinsic_version_id', ids: result.snapshot.sensorExtrinsicVersionIds, role: 'SENSOR_EXTRINSIC' },
      { column: 'sensor_status_id', ids: result.snapshot.sensorStatusIntervalIds, role: 'SENSOR_STATUS' },
      { column: 'detector_model_id', ids: result.snapshot.detectorModelIds, role: 'DETECTOR_MODEL' },
      { column: 'watermark_revision_id', ids: result.snapshot.watermarkRevisionIds, role: 'WATERMARK' },
    ];
    let coverageOrdinal = 1;
    for (const item of coverageInputs) {
      for (const id of new Set(item.ids ?? [])) {
        await transaction.query(`
          INSERT INTO stas.analysis_coverage_input(analysis_id,analysis_input_no,${item.column},input_role)
          VALUES ($1::uuid,$2::integer,$3::uuid,$4)
        `, [result.analysisId, coverageOrdinal, id, item.role]);
        coverageOrdinal += 1;
      }
    }
    const processingInputs: Array<{ column: string; ids: string[] | undefined; role: string }> = [
      { column: 'processing_run_id', ids: result.snapshot.processingRunIds, role: 'PROCESSING_RUN' },
      { column: 'rule_profile_id', ids: result.snapshot.ruleProfileIds, role: 'RULE_PROFILE' },
    ];
    let processingOrdinal = 1;
    for (const item of processingInputs) {
      for (const id of new Set(item.ids ?? [])) {
        await transaction.query(`
          INSERT INTO stas.analysis_processing_input(analysis_id,analysis_input_no,${item.column},input_role)
          VALUES ($1::uuid,$2::integer,$3::uuid,$4)
        `, [result.analysisId, processingOrdinal, id, item.role]);
        processingOrdinal += 1;
      }
    }
    let evidenceNo = 1;
    const persistedEvidence = new Set<string>();
    for (const evidence of result.evidence) {
      const key = `${evidence.type}:${evidence.id}`;
      if (persistedEvidence.has(key)) continue;
      const observationId = evidence.type === 'OBSERVATION' ? evidence.id : null;
      const measurementId = evidence.type === 'MEASUREMENT' ? evidence.id : null;
      const trackletVersionId = evidence.type === 'TRACKLET_VERSION' ? evidence.id : null;
      if (observationId === null && measurementId === null && trackletVersionId === null) continue;
      await transaction.query(`
        INSERT INTO stas.analysis_evidence_ref
          (analysis_id,evidence_no,evidence_type,observation_id,measurement_id,tracklet_version_id,time_range,summary_hash)
        VALUES ($1::uuid,$2::integer,$3,$4::text,$5::uuid,$6::uuid,NULL,$7)
      `, [result.analysisId, evidenceNo, evidence.type, observationId, measurementId, trackletVersionId, evidence.summaryHash ?? semanticAnalysisHash({ type: evidence.type, id: evidence.id })]);
      persistedEvidence.add(key);
      evidenceNo += 1;
    }
    await transaction.query('SELECT stas.assert_analysis_record_invariants($1::uuid)', [result.analysisId]);
    return result.analysisId;
  }

  public async execute(name: ToolName, rawInput: ToolInput, transaction: Transaction): Promise<RepositoryExecution> {
    switch (name) {
      case 'get_tracklet': return this.getTracklet(rawInput as GetTrackletInput, transaction);
      case 'get_tracklet_gaps': return this.getTrackletGaps(rawInput as GetTrackletGapsInput, transaction);
      case 'get_tracklet_quality': return this.getTrackletQuality(rawInput as GetTrackletQualityInput, transaction);
      case 'slice_tracklet': return this.sliceTracklet(rawInput as SliceTrackletInput, transaction);
      case 'get_position_at': return this.getPositionAt(rawInput as GetPositionAtInput, transaction);
      case 'get_motion_summary': return this.getMotionSummary(rawInput as GetMotionSummaryInput, transaction);
      case 'find_stop_intervals': return this.findStopIntervals(rawInput as FindStopIntervalsInput, transaction);
      case 'find_region_interactions': return this.findRegionInteractions(rawInput as FindRegionInteractionsInput, transaction);
      case 'find_tracklets_in_region': return this.findTrackletsInRegion(rawInput as FindTrackletsInRegionInput, transaction);
      case 'nearest_approach': return this.nearestApproach(rawInput as NearestApproachInput, transaction);
      case 'find_proximity_intervals': return this.findProximityIntervals(rawInput as FindProximityIntervalsInput, transaction);
      case 'find_nearby_tracklets': return this.findNearbyTracklets(rawInput as FindNearbyTrackletsInput, transaction);
      case 'find_successor_candidates': return this.findSuccessorCandidates(rawInput as FindSuccessorCandidatesInput, transaction);
      case 'compare_pair_features': return this.comparePairFeatures(rawInput as ComparePairFeaturesInput, transaction);
      case 'find_sensor_coverage': return this.findSensorCoverage(rawInput as FindSensorCoverageInput, transaction);
    }
  }

  private async resolveTracklet(dataScopeId: string, ref: VersionRef, transaction: Transaction): Promise<ResolvedTracklet> {
    const query = await transaction.query<ResolvedTracklet>(`
      SELECT tv.tracklet_id, tv.tracklet_version_id, tv.version_no,
             t.analysis_space_id, t.source_id, src.source_type,
             interp(tv.trajectory)::text AS interpolation,
             tv.max_accuracy_radius_m
      FROM gowm_stas_v1.tracklet_version tv
      JOIN gowm_stas_v1.tracklet t ON t.tracklet_id = tv.tracklet_id
      JOIN gowm_stas_v1.source src ON src.source_id = t.source_id
      WHERE t.data_scope_id = $1::uuid
        AND tv.tracklet_id = $2::uuid
        AND (($3::uuid IS NOT NULL AND tv.tracklet_version_id = $3::uuid)
          OR ($3::uuid IS NULL AND tv.version_no = $4::integer))
    `, [dataScopeId, ref.trackletId, ref.trackletVersionId ?? null, ref.versionNo ?? null]);
    const row = query.rows[0];
    if (row === undefined) {
      throw new AppError('NOT_FOUND', 404, 'Tracklet version not found', 'The pinned tracklet version does not exist in the authorized data scope.');
    }
    return row;
  }

  private async resolvePair(
    dataScopeId: string,
    a: VersionRef,
    b: VersionRef,
    transaction: Transaction,
  ): Promise<[ResolvedTracklet, ResolvedTracklet]> {
    const resolvedA = await this.resolveTracklet(dataScopeId, a, transaction);
    const resolvedB = await this.resolveTracklet(dataScopeId, b, transaction);
    assertSameAnalysisSpace(resolvedA, resolvedB);
    return [resolvedA, resolvedB];
  }

  private async resolveRegion(
    dataScopeId: string,
    region: { spatialObjectId?: string; spatialObjectVersionId: string },
    transaction: Transaction,
  ): Promise<ResolvedRegion> {
    const found = await transaction.query<ResolvedRegion>(`
      SELECT sov.spatial_object_id,sov.spatial_object_version_id,sov.analysis_space_id
      FROM gowm_stas_v1.spatial_object_version sov
      JOIN gowm_stas_v1.spatial_object so USING (spatial_object_id)
      WHERE sov.spatial_object_version_id=$1::uuid
        AND ($2::uuid IS NULL OR sov.spatial_object_id=$2::uuid)
        AND so.data_scope_id=$3::uuid
    `, [region.spatialObjectVersionId, region.spatialObjectId ?? null, dataScopeId]);
    const resolved = found.rows[0];
    if (resolved === undefined) throw new AppError('NOT_FOUND', 404, 'Region version not found', 'The spatial object version does not exist in the authorized data scope or does not belong to the supplied spatial object.');
    return resolved;
  }

  private async assertSensorRef(dataScopeId: string, sensorId: string, transaction: Transaction): Promise<void> {
    const found = await transaction.query(`
      SELECT 1 FROM gowm_stas_v1.sensor WHERE sensor_id=$1::uuid AND data_scope_id=$2::uuid
    `, [sensorId, dataScopeId]);
    if (found.rows.length === 0) {
      throw new AppError('NOT_FOUND', 404, 'Sensor not found', 'The sensor does not exist in the authorized data scope.');
    }
  }

  private async getTracklet(input: GetTrackletInput, transaction: Transaction): Promise<RepositoryExecution> {
    const version = await this.resolveTracklet(input.dataScopeId, input.tracklet, transaction);
    const summary = await transaction.query(`
      SELECT tv.tracklet_version_id, tv.tracklet_id, tv.version_no, tv.version_state,
             tv.start_event_time, tv.end_event_time,
             tv.start_time_lower, tv.start_time_upper, tv.end_time_lower, tv.end_time_upper,
             tv.sample_count, tv.sequence_count, tv.quality_score, tv.extent_box::text AS extent_box,
             getTime(tv.trajectory)::text AS temporal_domain,
             numInstants(tv.trajectory) AS instant_count,
             numSequences(tv.trajectory) AS sequence_count_from_value,
             interp(tv.trajectory)::text AS interpolation,
             t.source_id, t.sensor_deployment_id, t.tracker_session_id,
             t.source_local_target_id, t.analysis_space_id,
             tv.build_run_id, tv.rule_profile_id, tv.content_hash
      FROM gowm_stas_v1.tracklet_version tv
      JOIN gowm_stas_v1.tracklet t USING (tracklet_id)
      WHERE tv.tracklet_version_id = $1::uuid
    `, [version.tracklet_version_id]);
    const details: Record<string, unknown> = { summary: summary.rows[0] };
    if (input.detail === 'SEQUENCES') {
      const rows = await transaction.query(`
        SELECT segment_no, start_time, end_time, sample_count, interpolation,
               trajectory::text AS temporal_point
        FROM gowm_stas_v1.tracklet_segment
        WHERE tracklet_version_id = $1::uuid
        ORDER BY segment_no
        LIMIT $2::integer
      `, [version.tracklet_version_id, input.limit + 1]);
      if (rows.rows.length > input.limit) {
        throw new AppError('RESPONSE_TOO_LARGE', 413, 'Tracklet detail too large', 'Sequence detail exceeds the synchronous response limit.');
      }
      details.sequences = rows.rows;
    } else if (input.detail === 'OBSERVATION_REFS') {
      const rows = await transaction.query(`
        SELECT ti.segment_no, ti.ordinal_no, ti.inclusion_role, ti.measurement_id,
               ti.time_solution_id, m.observation_id
        FROM gowm_stas_v1.tracklet_input ti
        JOIN gowm_stas_v1.measurement m USING (measurement_id)
        WHERE ti.tracklet_version_id = $1::uuid
        ORDER BY ti.segment_no NULLS LAST, ti.ordinal_no NULLS LAST, ti.measurement_id
        LIMIT $2::integer
      `, [version.tracklet_version_id, input.limit + 1]);
      if (rows.rows.length > input.limit) {
        throw new AppError('RESPONSE_TOO_LARGE', 413, 'Tracklet detail too large', 'Observation references exceed the synchronous response limit.');
      }
      details.observationReferences = rows.rows;
    }
    return {
      status: 'COMPLETE', result: details, subjects: [subject(version)], snapshot: baseSnapshot([version]),
      algorithm: 'immutable-tracklet-version-read-v1', sqlTemplateId: 'get_tracklet.v1', interpolationPolicy: version.interpolation,
    };
  }

  private async getTrackletGaps(input: GetTrackletGapsInput, transaction: Transaction): Promise<RepositoryExecution> {
    const version = await this.resolveTracklet(input.dataScopeId, input.tracklet, transaction);
    const rows = await transaction.query(`
      SELECT gap_no, gap_time::text AS gap_time, primary_reason, reason_codes,
             observability_state, left_measurement_id, right_measurement_id,
             reason_confidence, details
      FROM gowm_stas_v1.tracklet_gap
      WHERE tracklet_version_id = $1::uuid
        AND gap_time && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        AND (cardinality($4::text[]) = 0 OR primary_reason = ANY($4::text[])
             OR reason_codes && $4::text[])
      ORDER BY lower(gap_time), gap_no
      LIMIT $5::integer
    `, [version.tracklet_version_id, input.timeRange.start, input.timeRange.end, input.reasons, input.limit + 1]);
    if (rows.rows.length > input.limit) {
      throw new AppError('TOO_MANY_RESULTS', 422, 'Too many gaps', 'The requested gap page exceeds the synchronous result limit.');
    }
    return {
      status: 'COMPLETE', result: { items: rows.rows }, subjects: [subject(version)], snapshot: baseSnapshot([version]),
      coverage: { requestedTime: input.timeRange }, algorithm: 'explicit-gap-table-read-v1', sqlTemplateId: 'get_tracklet_gaps.v1',
      interpolationPolicy: 'NO_INTERPOLATION_ACROSS_GAPS', page: { returned: rows.rows.length, truncated: false },
    };
  }

  private async getTrackletQuality(input: GetTrackletQualityInput, transaction: Transaction): Promise<RepositoryExecution> {
    const version = await this.resolveTracklet(input.dataScopeId, input.tracklet, transaction);
    const rangeStart = input.timeRange?.start ?? null;
    const rangeEnd = input.timeRange?.end ?? null;
    const rows = await transaction.query(`
      WITH gap_stats AS (
        SELECT count(*)::integer AS gap_count,
               COALESCE(sum(extract(epoch FROM upper(gap_time)-lower(gap_time))),0) AS gap_seconds,
               array_agg(DISTINCT reason ORDER BY reason) FILTER (WHERE reason IS NOT NULL) AS gap_reason_codes
        FROM gowm_stas_v1.tracklet_gap g
        LEFT JOIN LATERAL unnest(g.reason_codes) AS reason ON true
        WHERE g.tracklet_version_id=$1::uuid
          AND ($2::timestamptz IS NULL OR g.gap_time && tstzrange($2,$3,'[)'))
      ), input_stats AS (
        SELECT count(*)::integer AS input_count,
               count(*) FILTER (WHERE ti.inclusion_role <> 'INCLUDED')::integer AS rejected_count,
               count(DISTINCT ti.time_solution_id)::integer AS time_solution_count,
               count(DISTINCT m.processing_run_id)::integer AS processing_run_count,
               count(*) FILTER (WHERE pm.accuracy_model='UNKNOWN')::integer AS unknown_uncertainty_count,
               min(pm.accuracy_radius_m) AS min_accuracy_m,
               max(pm.accuracy_radius_m) AS max_accuracy_m
        FROM gowm_stas_v1.tracklet_input ti
        JOIN gowm_stas_v1.measurement m USING (measurement_id)
        JOIN gowm_stas_v1.position_measurement pm USING (measurement_id)
        WHERE ti.tracklet_version_id=$1::uuid
      ), conflict_stats AS (
        SELECT count(DISTINCT mr.left_measurement_id)::integer AS conflict_count
        FROM gowm_stas_v1.measurement_relation mr
        WHERE mr.relation_type='CONFLICTS_WITH'
          AND (mr.left_measurement_id IN (SELECT measurement_id FROM gowm_stas_v1.tracklet_input WHERE tracklet_version_id=$1::uuid)
            OR mr.right_measurement_id IN (SELECT measurement_id FROM gowm_stas_v1.tracklet_input WHERE tracklet_version_id=$1::uuid))
      )
      SELECT tv.quality_score, tv.sample_count, tv.sequence_count,
             extract(epoch FROM (tv.end_event_time-tv.start_event_time)) AS span_seconds,
             gs.*, ins.*, cs.conflict_count, tv.max_accuracy_radius_m,
             tv.rule_profile_id, tv.build_run_id
      FROM gowm_stas_v1.tracklet_version tv
      CROSS JOIN gap_stats gs CROSS JOIN input_stats ins CROSS JOIN conflict_stats cs
      WHERE tv.tracklet_version_id=$1::uuid
    `, [version.tracklet_version_id, rangeStart, rangeEnd]);
    return {
      status: 'COMPLETE', result: { dimensions: input.dimensions, values: rows.rows[0] },
      subjects: [subject(version)], snapshot: { ...baseSnapshot([version]), ruleProfileIds: [String(rows.rows[0]?.rule_profile_id)], processingRunIds: [String(rows.rows[0]?.build_run_id)] },
      coverage: input.timeRange === undefined ? {} : { requestedTime: input.timeRange },
      algorithm: 'independent-quality-dimensions-v1', sqlTemplateId: 'get_tracklet_quality.v1',
      quality: { grade: 'UNKNOWN', flags: ['NO_UNIVERSAL_SCORE_POLICY'] },
    };
  }

  private async sliceTracklet(input: SliceTrackletInput, transaction: Transaction): Promise<RepositoryExecution> {
    const version = await this.resolveTracklet(input.dataScopeId, input.tracklet, transaction);
    const region = input.region === undefined
      ? undefined
      : await this.resolveRegion(input.dataScopeId, input.region, transaction);
    if (region !== undefined) assertTrackletRegionAnalysisSpace(version, region);
    const span = input.timeRange === undefined ? null : toMobilitySpan(input.timeRange);
    const regionVersionId = input.region?.spatialObjectVersionId ?? null;
    const row = await transaction.query(`
      WITH v AS (
        SELECT tv.trajectory,
               CASE WHEN $2::text IS NULL THEN tv.trajectory
                    ELSE atTime(tv.trajectory,$2::tstzspan) END AS time_slice
        FROM gowm_stas_v1.tracklet_version tv
        WHERE tv.tracklet_version_id=$1::uuid
      ), region AS (
        SELECT sov.spatial_object_version_id, sov.geometry
        FROM gowm_stas_v1.spatial_object_version sov
        JOIN gowm_stas_v1.spatial_object so USING (spatial_object_id)
        WHERE sov.spatial_object_version_id=$3::uuid AND sov.spatial_object_id=$5::uuid AND so.data_scope_id=$4::uuid
      ), clipped AS (
        SELECT v.time_slice,
               CASE WHEN $3::uuid IS NULL THEN v.time_slice
                    ELSE atGeometry(v.time_slice, region.geometry) END AS fragment,
               region.spatial_object_version_id
        FROM v LEFT JOIN region ON true
      )
      SELECT time_slice IS NOT NULL AS temporal_evaluable,
             fragment::text AS temporal_point,
             getTime(fragment)::text AS temporal_domain,
             numSequences(fragment) AS sequence_count,
             spatial_object_version_id
      FROM clipped
    `, [version.tracklet_version_id, span, regionVersionId, input.dataScopeId, input.region?.spatialObjectId ?? null]);
    const rawResult = row.rows[0];
    const temporalEvaluable = rawResult?.temporal_evaluable === true;
    const result = temporalEvaluable
      ? {
          temporal_point: rawResult.temporal_point ?? null,
          temporal_domain: rawResult.temporal_domain ?? null,
          sequence_count: rawResult.temporal_point === null || rawResult.temporal_point === undefined
            ? 0
            : rawResult.sequence_count,
          spatial_object_version_id: rawResult.spatial_object_version_id ?? regionVersionId,
        }
      : null;
    return {
      status: temporalEvaluable ? 'COMPLETE' : 'NO_DATA', result,
      subjects: [subject(version)],
      snapshot: { ...baseSnapshot([version]), ...(regionVersionId === null ? {} : { spatialObjectVersionIds: [regionVersionId] }) },
      coverage: input.timeRange === undefined ? {} : { requestedTime: input.timeRange },
      algorithm: 'mobilitydb-at-time-at-geometry-v1', sqlTemplateId: 'slice_tracklet.v1',
      interpolationPolicy: version.interpolation,
      warnings: input.boundaryPolicy === 'REPORT_AMBIGUOUS' && regionVersionId !== null
        ? [{ code: 'BOUNDARY_UNCERTAINTY_REPORTED_SEPARATELY', message: 'The fragment is nominal; inspect the pinned region boundary accuracy before semantic use.' }]
        : [],
    };
  }

  private async getPositionAt(input: GetPositionAtInput, transaction: Transaction): Promise<RepositoryExecution> {
    const version = await this.resolveTracklet(input.dataScopeId, input.tracklet, transaction);
    const rows = await transaction.query(`
      WITH v AS (
        SELECT valueAtTimestamp(tv.trajectory,$2::timestamptz) AS position
        FROM gowm_stas_v1.tracklet_version tv WHERE tv.tracklet_version_id=$1::uuid
      ), observed AS (
        SELECT ti.measurement_id, ti.time_solution_id, m.observation_id,
               ts.phenomenon_time_estimate
        FROM gowm_stas_v1.tracklet_input ti
        JOIN gowm_stas_v1.measurement m USING (measurement_id)
        JOIN gowm_stas_v1.observation_time_solution ts ON ts.time_solution_id=ti.time_solution_id
        WHERE ti.tracklet_version_id=$1::uuid
          AND ts.phenomenon_time_estimate=$2::timestamptz
        ORDER BY ti.measurement_id LIMIT 1
      )
      SELECT ST_AsGeoJSON(v.position)::jsonb AS position,
             ST_SRID(v.position) AS srid,
             (observed.measurement_id IS NOT NULL) AS is_observed,
             observed.measurement_id, observed.time_solution_id, observed.observation_id
      FROM v LEFT JOIN observed ON true
      WHERE v.position IS NOT NULL
    `, [version.tracklet_version_id, input.timestamp]);
    const row = rows.rows[0];
    const observed = row?.is_observed === true;
    if (row === undefined || (input.interpolationPolicy === 'OBSERVED_ONLY' && !observed)) {
      const gapRows = await transaction.query(`
        SELECT gap_no,lower(gap_time) AS gap_start,upper(gap_time) AS gap_end,
               lower_inc(gap_time) AS lower_inclusive,upper_inc(gap_time) AS upper_inclusive,
               reason_codes,observability_state
        FROM gowm_stas_v1.tracklet_gap WHERE tracklet_version_id=$1::uuid AND gap_time @> $2::timestamptz
      `, [version.tracklet_version_id, input.timestamp]);
      const gaps = gapRows.rows.map((gap) => ({
        id: `${version.tracklet_version_id}:${String(gap.gap_no)}`,
        timeRange: {
          start: new Date(String(gap.gap_start)).toISOString(), end: new Date(String(gap.gap_end)).toISOString(),
          bounds: `${gap.lower_inclusive === true ? '[' : '('}${gap.upper_inclusive === true ? ']' : ')'}` as '()' | '[]' | '[)' | '(]',
        },
        reasonCodes: gap.reason_codes as string[], observability: String(gap.observability_state),
      }));
      return {
        status: 'NO_DATA', result: null, subjects: [subject(version)], snapshot: baseSnapshot([version]),
        algorithm: 'value-at-timestamp-with-observation-provenance-v1', sqlTemplateId: 'get_position_at.v1',
        interpolationPolicy: input.interpolationPolicy,
        gaps,
        assumptions: input.interpolationPolicy === 'OBSERVED_ONLY' && gaps.length === 0
          ? [{ code: 'OBSERVED_ONLY_REJECTED_INTERPOLATED_VALUE', description: 'The timestamp is in a defined sequence but has no pinned source Measurement at exactly this time.' }]
          : [],
        warnings: gaps.length === 0 && !(input.interpolationPolicy === 'OBSERVED_ONLY' && row !== undefined)
          ? [{ code: 'OUTSIDE_TRACKLET_DOMAIN', message: 'The timestamp is outside the temporal domain and is not an explicit internal gap.' }]
          : [],
      };
    }
    return {
      status: 'COMPLETE', result: { ...row, valueKind: observed ? 'OBSERVED' : 'INTERPOLATED' },
      subjects: [subject(version)],
      snapshot: { ...baseSnapshot([version]), ...(row.time_solution_id === null ? {} : { timeSolutionIds: [String(row.time_solution_id)] }) },
      algorithm: 'value-at-timestamp-with-observation-provenance-v1', sqlTemplateId: 'get_position_at.v1',
      interpolationPolicy: input.interpolationPolicy,
      uncertainties: observed ? [] : [{ quantity: 'POSITION', model: 'UNKNOWN', conclusion: 'Interpolation does not reduce endpoint uncertainty.' }],
      evidence: observed ? [
        { id: String(row.observation_id), type: 'OBSERVATION' },
        { id: String(row.measurement_id), type: 'MEASUREMENT' },
      ] : [],
    };
  }

  private async getMotionSummary(input: GetMotionSummaryInput, transaction: Transaction): Promise<RepositoryExecution> {
    const version = await this.resolveTracklet(input.dataScopeId, input.tracklet, transaction);
    if (version.interpolation.toUpperCase() !== 'LINEAR') {
      throw new AppError('UNSUPPORTED_INTERPOLATION', 422, 'Interpolation unsupported', 'Motion functions require a v1 LINEAR tracklet.');
    }
    const rows = await transaction.query(`
      WITH x AS (
        SELECT atTime(trajectory,$2::tstzspan) AS t
        FROM gowm_stas_v1.tracklet_version
        WHERE tracklet_version_id=$1::uuid AND trajectory && $2::tstzspan
      ), overall AS (
        SELECT duration(t,false) AS defined_duration,
               duration(t,true) AS bounding_duration,
               duration(t,true)-duration(t,false) AS gap_duration,
               timeSpan(t)::text AS overall_span
        FROM x WHERE t IS NOT NULL
      ), seq AS (
        SELECT u.sequence_no, u.q AS t
        FROM x CROSS JOIN LATERAL unnest(sequences(t)) WITH ORDINALITY AS u(q,sequence_no)
        WHERE t IS NOT NULL
      ), m AS (SELECT sequence_no,t,speed(t) AS s FROM seq)
      SELECT sequence_no, length(t) AS distance_m, duration(t,false) AS sequence_duration,
             timeSpan(t)::text AS sequence_span, minValue(s) AS min_speed_mps,
             maxValue(s) AS max_speed_mps, twAvg(s) AS time_weighted_average_speed_mps,
             direction(t)::text AS direction_profile,
             o.defined_duration,o.bounding_duration,o.gap_duration,o.overall_span
      FROM m CROSS JOIN overall o ORDER BY sequence_no
    `, [version.tracklet_version_id, toMobilitySpan(input.timeRange)]);
    const totalDistance = rows.rows.reduce((sum, row) => sum + Number(row.distance_m ?? 0), 0);
    return {
      status: rows.rows.length === 0 ? 'NO_DATA' : 'COMPLETE',
      result: rows.rows.length === 0 ? null : { totalDistanceMeters: totalDistance, sequences: rows.rows },
      subjects: [subject(version)], snapshot: baseSnapshot([version]), coverage: { requestedTime: input.timeRange },
      algorithm: 'per-sequence-linear-motion-summary-v1', sqlTemplateId: 'get_motion_summary.v1',
      interpolationPolicy: 'LINEAR_WITHIN_SEQUENCE_ONLY',
    };
  }

  private async findStopIntervals(input: FindStopIntervalsInput, transaction: Transaction): Promise<RepositoryExecution> {
    const version = await this.resolveTracklet(input.dataScopeId, input.tracklet, transaction);
    if (version.interpolation.toUpperCase() !== 'LINEAR') {
      throw new AppError('UNSUPPORTED_INTERPOLATION', 422, 'Interpolation unsupported', 'Stop extraction requires a v1 LINEAR tracklet.');
    }
    const rows = await transaction.query(`
      WITH x AS (
        SELECT atTime(trajectory,$2::tstzspan) AS t
        FROM gowm_stas_v1.tracklet_version WHERE tracklet_version_id=$1::uuid
      ), stop_domain AS (
        SELECT getTime(stops(t,$3::double precision,make_interval(secs => $4::double precision))) AS spans
        FROM x WHERE t IS NOT NULL
      ), expanded AS (
        SELECT u.ordinality AS stop_no, u.span
        FROM stop_domain
        CROSS JOIN LATERAL unnest(public.spans(stop_domain.spans)) WITH ORDINALITY AS u(span,ordinality)
        WHERE stop_domain.spans IS NOT NULL
      )
      SELECT stop_no, span::text AS time_span,
             extract(epoch FROM duration(span)) AS duration_seconds
      FROM expanded ORDER BY lower(span) LIMIT $5::integer
    `, [version.tracklet_version_id, toMobilitySpan(input.timeRange), input.maximumDiameterMeters, input.minimumDurationSeconds, input.limit + 1]);
    if (rows.rows.length > input.limit) {
      throw new AppError('TOO_MANY_RESULTS', 422, 'Too many stop intervals', 'Stop intervals exceed the synchronous result limit.');
    }
    let evaluable = rows.rows.length > 0;
    if (!evaluable) {
      const domain = await transaction.query<{ evaluable: boolean }>(`
        SELECT atTime(trajectory,$2::tstzspan) IS NOT NULL AS evaluable
        FROM gowm_stas_v1.tracklet_version WHERE tracklet_version_id=$1::uuid
      `, [version.tracklet_version_id, toMobilitySpan(input.timeRange)]);
      evaluable = domain.rows[0]?.evaluable === true;
    }
    return {
      status: evaluable ? 'COMPLETE' : 'NO_DATA', result: evaluable ? { items: rows.rows } : null,
      subjects: [subject(version)], snapshot: baseSnapshot([version]), coverage: { requestedTime: input.timeRange },
      algorithm: 'mobilitydb-stops-v1', sqlTemplateId: 'find_stop_intervals.v1', interpolationPolicy: 'LINEAR_WITHIN_SEQUENCE_ONLY',
      uncertainties: [{ quantity: 'STOP_DIAMETER', model: version.max_accuracy_radius_m === null ? 'UNKNOWN' : 'HARD_RADIUS', value: version.max_accuracy_radius_m, unit: 'm', conclusion: 'THRESHOLD_SENSITIVITY' }],
      page: { returned: rows.rows.length, truncated: false },
    };
  }

  private async findRegionInteractions(input: FindRegionInteractionsInput, transaction: Transaction): Promise<RepositoryExecution> {
    const version = await this.resolveTracklet(input.dataScopeId, input.tracklet, transaction);
    const region = await this.resolveRegion(input.dataScopeId, input.region, transaction);
    assertTrackletRegionAnalysisSpace(version, region);
    const rows = await transaction.query(`
      WITH region AS (
        SELECT sov.geometry, sov.boundary_accuracy_m
        FROM gowm_stas_v1.spatial_object_version sov
        JOIN gowm_stas_v1.spatial_object so USING (spatial_object_id)
        WHERE sov.spatial_object_version_id=$2::uuid AND sov.spatial_object_id=$6::uuid AND so.data_scope_id=$3::uuid
      ), x AS (
        SELECT atTime(tv.trajectory,$4::tstzspan) AS t, region.geometry, region.boundary_accuracy_m
        FROM gowm_stas_v1.tracklet_version tv CROSS JOIN region
        WHERE tv.tracklet_version_id=$1::uuid
          AND tv.trajectory && $4::tstzspan
          AND tv.trajectory && stbox(region.geometry)
          AND eIntersects(tv.trajectory,region.geometry)
      ), inside AS (
        SELECT atGeometry(t,geometry) AS fragment,boundary_accuracy_m FROM x WHERE t IS NOT NULL
      ), visits AS (
        SELECT u.ordinality AS visit_no,u.span,inside.boundary_accuracy_m
        FROM inside CROSS JOIN LATERAL unnest(public.spans(getTime(inside.fragment))) WITH ORDINALITY AS u(span,ordinality)
        WHERE inside.fragment IS NOT NULL
      )
      SELECT v.visit_no,v.span::text AS visit_time,
             lower(v.span) AS visit_start,upper(v.span) AS visit_end,
             extract(epoch FROM duration(v.span)) AS duration_seconds,
             seg.segment_no,seg.start_time AS sequence_start,seg.end_time AS sequence_end,
             CASE WHEN lower(v.span)>seg.start_time THEN 'ENTER' ELSE 'APPEARED_INSIDE' END AS start_event,
             CASE WHEN upper(v.span)<seg.end_time THEN 'EXIT' ELSE 'DISAPPEARED_INSIDE' END AS end_event,
             (lower(v.span)>seg.start_time AND upper(v.span)<seg.end_time) AS is_cross,
             (duration(v.span)=interval '0') AS is_touch,
             v.boundary_accuracy_m
      FROM visits v
      LEFT JOIN gowm_stas_v1.tracklet_segment seg ON seg.tracklet_version_id=$1::uuid
        AND lower(v.span)>=seg.start_time AND upper(v.span)<=seg.end_time
      ORDER BY lower(v.span),v.visit_no LIMIT $5::integer
    `, [version.tracklet_version_id, input.region.spatialObjectVersionId, input.dataScopeId, toMobilitySpan(input.timeRange), input.limit + 1, input.region.spatialObjectId]);
    if (rows.rows.length > input.limit) {
      throw new AppError('TOO_MANY_RESULTS', 422, 'Too many region interactions', 'Region interactions exceed the synchronous cap.');
    }
    if (rows.rows.length === 0) {
      const domain = await transaction.query<{ evaluable: boolean }>(`
        SELECT atTime(trajectory,$2::tstzspan) IS NOT NULL AS evaluable
        FROM gowm_stas_v1.tracklet_version WHERE tracklet_version_id=$1::uuid
      `, [version.tracklet_version_id, toMobilitySpan(input.timeRange)]);
      const evaluable = domain.rows[0]?.evaluable === true;
      return {
        status: evaluable ? 'COMPLETE' : 'NO_DATA', result: evaluable ? { items: [] } : null, subjects: [subject(version)],
        snapshot: { ...baseSnapshot([version]), spatialObjectVersionIds: [input.region.spatialObjectVersionId] },
        coverage: { requestedTime: input.timeRange }, algorithm: 'region-visit-domain-v1', sqlTemplateId: 'find_region_interactions.v1',
      };
    }
    const items: Array<Record<string, unknown>> = [];
    for (const row of rows.rows) {
      if (input.events.includes('VISIT') && Number(row.duration_seconds) >= input.minimumVisitSeconds) {
        items.push({ kind: 'VISIT', visitNo: row.visit_no, timeRange: row.visit_time, durationSeconds: Number(row.duration_seconds) });
      }
      if (input.events.includes('ENTER')) items.push({ kind: row.start_event, visitNo: row.visit_no, timestamp: row.visit_start, valueKind: 'DERIVED_FROM_INTERPOLATION_MODEL' });
      if (input.events.includes('EXIT')) items.push({ kind: row.end_event, visitNo: row.visit_no, timestamp: row.visit_end, valueKind: 'DERIVED_FROM_INTERPOLATION_MODEL' });
      if (input.events.includes('TOUCH') && row.is_touch === true) items.push({ kind: 'TOUCH', visitNo: row.visit_no, timestamp: row.visit_start, valueKind: 'DERIVED_FROM_INTERPOLATION_MODEL' });
      if (input.events.includes('CROSS') && row.is_cross === true) items.push({ kind: 'CROSS', visitNo: row.visit_no, timeRange: row.visit_time, valueKind: 'DERIVED' });
    }
    const boundaryAccuracy = rows.rows[0]?.boundary_accuracy_m;
    return {
      status: 'COMPLETE', result: { items },
      subjects: [subject(version)],
      snapshot: { ...baseSnapshot([version]), spatialObjectVersionIds: [input.region.spatialObjectVersionId] },
      coverage: { requestedTime: input.timeRange }, algorithm: 'region-visit-domain-and-boundary-classification-v1', sqlTemplateId: 'find_region_interactions.v1',
      uncertainties: [{ quantity: 'REGION_BOUNDARY', model: boundaryAccuracy === null ? 'UNKNOWN' : 'HARD_RADIUS', value: boundaryAccuracy, unit: 'm', conclusion: input.boundaryPolicy }],
      page: { returned: items.length, truncated: false },
    };
  }

  private async findTrackletsInRegion(input: FindTrackletsInRegionInput, transaction: Transaction): Promise<RepositoryExecution> {
    const region = await this.resolveRegion(input.dataScopeId, input.region, transaction);
    const coarse = await transaction.query<{ tracklet_version_id: string; tracklet_id: string; version_no: number }>(`
      WITH region AS (
        SELECT sov.geometry, sov.spatial_object_version_id
        FROM gowm_stas_v1.spatial_object_version sov
        JOIN gowm_stas_v1.spatial_object so USING (spatial_object_id)
        WHERE sov.spatial_object_version_id=$1::uuid AND sov.spatial_object_id=$6::uuid AND so.data_scope_id=$2::uuid
      )
      SELECT tv.tracklet_version_id,tv.tracklet_id,tv.version_no
      FROM region
      JOIN gowm_stas_v1.tracklet t ON t.data_scope_id=$2::uuid AND t.analysis_space_id=$7::uuid
      JOIN gowm_stas_v1.tracklet_head h ON h.tracklet_id=t.tracklet_id
      JOIN gowm_stas_v1.tracklet_version tv ON tv.tracklet_version_id=h.current_version_id
      JOIN gowm_stas_v1.source src ON src.source_id=t.source_id
      WHERE (cardinality($4::text[])=0 OR src.source_type=ANY($4::text[]))
        AND tv.trajectory && $3::tstzspan
        AND tv.trajectory && stbox(region.geometry)
      ORDER BY tv.tracklet_version_id LIMIT $5::integer
    `, [input.region.spatialObjectVersionId, input.dataScopeId, toMobilitySpan(input.timeRange), input.sourceTypes, input.limit + 1, input.region.spatialObjectId, region.analysis_space_id]);
    if (coarse.rows.length > input.limit) {
      throw new AppError('TOO_MANY_CANDIDATES', 422, 'Too many region candidates', 'The complete coarse candidate set exceeds the synchronous cap.', {
        cap: input.limit,
        observedAtLeast: input.limit + 1,
      });
    }
    let rows = coarse;
    if (input.mode === 'EXACT_VISIT' && coarse.rows.length > 0) {
      const ids = coarse.rows.map((row) => row.tracklet_version_id);
      rows = await transaction.query(`
        WITH region AS (
          SELECT sov.geometry FROM gowm_stas_v1.spatial_object_version sov
          JOIN gowm_stas_v1.spatial_object so USING (spatial_object_id)
          WHERE sov.spatial_object_version_id=$1::uuid AND sov.spatial_object_id=$5::uuid AND so.data_scope_id=$2::uuid
        )
        SELECT tv.tracklet_version_id,tv.tracklet_id,tv.version_no,t.analysis_space_id,
               getTime(atGeometry(atTime(tv.trajectory,$3::tstzspan),region.geometry))::text AS exact_visit_times
        FROM region
        JOIN unnest($4::uuid[]) ids(tracklet_version_id) ON true
        JOIN gowm_stas_v1.tracklet_version tv USING (tracklet_version_id)
        JOIN gowm_stas_v1.tracklet t USING (tracklet_id)
        WHERE t.analysis_space_id=$6::uuid
          AND eIntersects(atTime(tv.trajectory,$3::tstzspan),region.geometry)
        ORDER BY tv.tracklet_version_id
      `, [input.region.spatialObjectVersionId, input.dataScopeId, toMobilitySpan(input.timeRange), ids, input.region.spatialObjectId, region.analysis_space_id]);
    }
    const outputRows = rows.rows.map((row) => ({
      ...row,
      match_stage: input.mode === 'CANDIDATE' ? 'BBOX_CANDIDATE' : 'EXACT_VISIT',
      visit_times: 'exact_visit_times' in row && row.exact_visit_times !== null ? String(row.exact_visit_times) : null,
    }));
    return {
      status: 'COMPLETE', result: { items: outputRows }, subjects: [{ kind: 'SPATIAL_OBJECT_VERSION', id: input.region.spatialObjectVersionId }],
      snapshot: { trackletVersions: coarse.rows.map((row) => ({ trackletId: String(row.tracklet_id), trackletVersionId: String(row.tracklet_version_id), versionNo: Number(row.version_no) })), spatialObjectVersionIds: [input.region.spatialObjectVersionId] },
      coverage: { requestedTime: input.timeRange }, algorithm: 'region-bbox-then-exact-v1', sqlTemplateId: 'find_tracklets_in_region.v1',
      candidateCount: coarse.rows.length, exactCount: input.mode === 'EXACT_VISIT' ? rows.rows.length : undefined,
      page: { returned: outputRows.length, truncated: false },
    };
  }

  private async nearestApproach(input: NearestApproachInput, transaction: Transaction): Promise<RepositoryExecution> {
    const [a, b] = await this.resolvePair(input.dataScopeId, input.trackletA, input.trackletB, transaction);
    const rows = await transaction.query(`
      WITH p AS (
        SELECT atTime(a.trajectory,$3::tstzspan) AS ta,
               atTime(b.trajectory,$3::tstzspan) AS tb
        FROM gowm_stas_v1.tracklet_version a, gowm_stas_v1.tracklet_version b
        WHERE a.tracklet_version_id=$1::uuid AND b.tracklet_version_id=$2::uuid
          AND a.trajectory && $3::tstzspan AND b.trajectory && $3::tstzspan
          AND a.trajectory && timeSpan(b.trajectory)
      ), common_domain AS (
        SELECT ta,tb,(getTime(ta) * getTime(tb)) AS common_time
        FROM p WHERE ta IS NOT NULL AND tb IS NOT NULL
      )
      SELECT ta |=| tb AS minimum_distance_m,
             nearestApproachInstant(ta,tb)::text AS nearest_instant,
             ST_AsGeoJSON(shortestLine(ta,tb))::jsonb AS shortest_line,
             getTime(ta)::text AS coverage_a,getTime(tb)::text AS coverage_b,
             common_time::text AS common_time
      FROM common_domain WHERE common_time IS NOT NULL
    `, [a.tracklet_version_id, b.tracklet_version_id, toMobilitySpan(input.timeRange)]);
    const row = rows.rows[0];
    const hasDefinedDistance = row !== undefined
      && row.minimum_distance_m !== null
      && row.minimum_distance_m !== undefined;
    const minimumDistance = hasDefinedDistance ? Number(row.minimum_distance_m) : null;
    return {
      status: hasDefinedDistance ? 'COMPLETE' : 'NO_DATA', result: hasDefinedDistance ? row : null,
      subjects: [subject(a), subject(b)], snapshot: baseSnapshot([a, b]), coverage: { requestedTime: input.timeRange },
      algorithm: 'mobilitydb-nearest-approach-v1', sqlTemplateId: 'nearest_approach.v1',
      uncertaintyPolicy: input.uncertaintyPolicy, uncertainties: conservativeDistanceUncertainty(minimumDistance, a, b),
      warnings: hasDefinedDistance ? [{ code: 'FIRST_NEAREST_INSTANT_ONLY', message: 'MobilityDB returns one nearest approach instant if the minimum occurs more than once.' }] : [],
    };
  }

  private async findProximityIntervals(input: FindProximityIntervalsInput, transaction: Transaction): Promise<RepositoryExecution> {
    const [a, b] = await this.resolvePair(input.dataScopeId, input.trackletA, input.trackletB, transaction);
    const rows = await transaction.query(`
      WITH p AS (
        SELECT atTime(a.trajectory,$3::tstzspan) AS ta,atTime(b.trajectory,$3::tstzspan) AS tb
        FROM gowm_stas_v1.tracklet_version a,gowm_stas_v1.tracklet_version b
        WHERE a.tracklet_version_id=$1::uuid AND b.tracklet_version_id=$2::uuid
      ), domain AS (
        SELECT whenTrue(tDwithin(ta,tb,$4::double precision)) AS spans, ta |=| tb AS min_distance_m
        FROM p WHERE ta IS NOT NULL AND tb IS NOT NULL
      ), expanded AS (
        SELECT u.ordinality AS interval_no,u.span,domain.min_distance_m
        FROM domain CROSS JOIN LATERAL unnest(public.spans(domain.spans)) WITH ORDINALITY AS u(span,ordinality)
        WHERE domain.spans IS NOT NULL
      )
      SELECT interval_no,span::text AS time_span,
             extract(epoch FROM duration(span)) AS duration_seconds,min_distance_m
      FROM expanded
      WHERE extract(epoch FROM duration(span)) >= $5::double precision
      ORDER BY lower(span) LIMIT $6::integer
    `, [a.tracklet_version_id, b.tracklet_version_id, toMobilitySpan(input.timeRange), input.maxDistanceMeters, input.minimumDurationSeconds, input.limit + 1]);
    if (rows.rows.length > input.limit) {
      throw new AppError('TOO_MANY_RESULTS', 422, 'Too many proximity intervals', 'The proximity interval result exceeds the synchronous cap.');
    }
    let evaluable = rows.rows.length > 0;
    let minDistance = rows.rows.length === 0 ? null : Math.min(...rows.rows.map((row) => Number(row.min_distance_m)));
    if (!evaluable) {
      const domain = await transaction.query<{ evaluable: boolean; min_distance_m: number | null }>(`
        WITH p AS (
          SELECT atTime(a.trajectory,$3::tstzspan) AS ta,atTime(b.trajectory,$3::tstzspan) AS tb
          FROM gowm_stas_v1.tracklet_version a,gowm_stas_v1.tracklet_version b
          WHERE a.tracklet_version_id=$1::uuid AND b.tracklet_version_id=$2::uuid
        )
        SELECT CASE WHEN ta IS NULL OR tb IS NULL THEN false
                    ELSE (getTime(ta) * getTime(tb)) IS NOT NULL END AS evaluable,
               CASE WHEN ta IS NULL OR tb IS NULL OR (getTime(ta) * getTime(tb)) IS NULL
                    THEN NULL ELSE ta |=| tb END AS min_distance_m
        FROM p
      `, [a.tracklet_version_id, b.tracklet_version_id, toMobilitySpan(input.timeRange)]);
      evaluable = domain.rows[0]?.evaluable === true;
      minDistance = domain.rows[0]?.min_distance_m === null || domain.rows[0]?.min_distance_m === undefined
        ? null : Number(domain.rows[0].min_distance_m);
    }
    return {
      status: evaluable ? 'COMPLETE' : 'NO_DATA', result: evaluable ? { intervals: rows.rows } : null,
      subjects: [subject(a), subject(b)], snapshot: baseSnapshot([a, b]), coverage: { requestedTime: input.timeRange },
      algorithm: 'mobilitydb-tdwithin-when-true-v1', sqlTemplateId: 'find_proximity_intervals.v1',
      interpolationPolicy: 'LINEAR_WITHIN_SEQUENCE_ONLY', uncertaintyPolicy: input.uncertaintyPolicy,
      uncertainties: conservativeDistanceUncertainty(minDistance, a, b), page: { returned: rows.rows.length, truncated: false },
    };
  }

  private async findNearbyTracklets(input: FindNearbyTrackletsInput, transaction: Transaction): Promise<RepositoryExecution> {
    const version = await this.resolveTracklet(input.dataScopeId, input.subject, transaction);
    const subjectDomain = await transaction.query<{ evaluable: boolean }>(`
      SELECT atTime(trajectory,$2::tstzspan) IS NOT NULL AS evaluable
      FROM gowm_stas_v1.tracklet_version WHERE tracklet_version_id=$1::uuid
    `, [version.tracklet_version_id, toMobilitySpan(input.timeRange)]);
    if (subjectDomain.rows[0]?.evaluable !== true) {
      return {
        status: 'NO_DATA', result: null, subjects: [subject(version)], snapshot: baseSnapshot([version]),
        coverage: { requestedTime: input.timeRange }, algorithm: 'stbox-candidate-then-exact-v1', sqlTemplateId: 'find_nearby_tracklets.v1',
        candidateCount: 0, exactCount: 0, page: { returned: 0, truncated: false },
      };
    }
    let coarseRadius = input.maxDistanceMeters;
    if (input.uncertaintyPolicy === 'CONSERVATIVE_BOUND' && version.max_accuracy_radius_m === null) {
      throw new AppError('UNSUPPORTED_UNCERTAINTY_MODEL', 422, 'Uncertainty bound unavailable', 'A complete conservative candidate set requires a hard maximum position-error radius.');
    }
    if (input.uncertaintyPolicy === 'CONSERVATIVE_BOUND') {
      const eligibleBounds = await transaction.query<{ has_unknown: boolean; maximum_radius_m: number | null }>(`
        SELECT bool_or(tv.max_accuracy_radius_m IS NULL) AS has_unknown,
               max(tv.max_accuracy_radius_m) AS maximum_radius_m
          FROM gowm_stas_v1.tracklet t
          JOIN gowm_stas_v1.tracklet_head h ON h.tracklet_id=t.tracklet_id
          JOIN gowm_stas_v1.tracklet_version tv ON tv.tracklet_version_id=h.current_version_id
          JOIN gowm_stas_v1.source src ON src.source_id=t.source_id
          WHERE t.data_scope_id=$1::uuid AND t.analysis_space_id=$2::uuid
            AND t.tracklet_id<>$3::uuid
            AND tv.trajectory && $4::tstzspan
            AND (cardinality($5::text[])=0 OR src.source_type=ANY($5::text[]))
      `, [input.dataScopeId, version.analysis_space_id, version.tracklet_id, toMobilitySpan(input.timeRange), input.sourceTypes]);
      if (eligibleBounds.rows[0]?.has_unknown === true) {
        throw new AppError('UNSUPPORTED_UNCERTAINTY_MODEL', 422, 'Candidate bounds unavailable', 'A complete conservative candidate set cannot be produced because at least one eligible tracklet lacks a hard maximum error radius.');
      }
      coarseRadius += (version.max_accuracy_radius_m ?? 0) + (eligibleBounds.rows[0]?.maximum_radius_m ?? 0);
    }
    const candidates = await transaction.query<{ tracklet_version_id: string; tracklet_id: string; version_no: number }>(`
      WITH subject AS (
        SELECT tv.tracklet_id,t.analysis_space_id,atTime(tv.trajectory,$2::tstzspan) AS trajectory
        FROM gowm_stas_v1.tracklet_version tv JOIN gowm_stas_v1.tracklet t USING (tracklet_id)
        WHERE tv.tracklet_version_id=$1::uuid AND t.data_scope_id=$3::uuid
      )
      SELECT c.tracklet_version_id,c.tracklet_id,c.version_no
      FROM subject s
      JOIN gowm_stas_v1.tracklet t ON t.data_scope_id=$3::uuid
                         AND t.analysis_space_id=s.analysis_space_id
                         AND t.tracklet_id<>s.tracklet_id
      JOIN gowm_stas_v1.tracklet_head h ON h.tracklet_id=t.tracklet_id
      JOIN gowm_stas_v1.tracklet_version c ON c.tracklet_version_id=h.current_version_id
      JOIN gowm_stas_v1.source src ON src.source_id=t.source_id
      WHERE s.trajectory IS NOT NULL
        AND (cardinality($4::text[])=0 OR src.source_type=ANY($4::text[]))
        AND c.trajectory && $2::tstzspan
        AND c.trajectory && expandSpace(s.trajectory,$5::double precision)
      ORDER BY c.tracklet_version_id LIMIT $6::integer
    `, [version.tracklet_version_id, toMobilitySpan(input.timeRange), input.dataScopeId, input.sourceTypes, coarseRadius, input.limit + 1]);
    if (candidates.rows.length > input.limit) {
      throw new AppError('TOO_MANY_CANDIDATES', 422, 'Too many nearby candidates', 'The complete coarse candidate set exceeds the synchronous cap.', {
        cap: input.limit,
        observedAtLeast: input.limit + 1,
      });
    }
    const ids = candidates.rows.map((row) => row.tracklet_version_id);
    if (ids.length === 0) {
      return {
        status: 'COMPLETE', result: { items: [] }, subjects: [subject(version)], snapshot: baseSnapshot([version]),
        coverage: { requestedTime: input.timeRange }, algorithm: 'stbox-candidate-then-exact-v1', sqlTemplateId: 'find_nearby_tracklets.v1',
        candidateCount: 0, exactCount: 0, page: { returned: 0, truncated: false },
      };
    }
    if (input.mode === 'CANDIDATE') {
      return {
        status: 'COMPLETE', result: { items: candidates.rows.map((row) => ({ ...row, matchStage: 'STBOX_CANDIDATE' })) },
        subjects: [subject(version)], snapshot: { ...baseSnapshot([version]), trackletVersions: [...baseSnapshot([version]).trackletVersions, ...candidates.rows.map((row) => ({ trackletId: row.tracklet_id, trackletVersionId: row.tracklet_version_id, versionNo: row.version_no }))] },
        coverage: { requestedTime: input.timeRange }, algorithm: 'stbox-candidate-v1', sqlTemplateId: 'find_nearby_tracklets.v1',
        candidateCount: ids.length, page: { returned: ids.length, truncated: false },
      };
    }
    const exact = await transaction.query(`
      WITH subject AS (
        SELECT atTime(trajectory,$2::tstzspan) AS t,max_accuracy_radius_m AS radius_m
        FROM gowm_stas_v1.tracklet_version WHERE tracklet_version_id=$1::uuid
      ), c AS (
        SELECT tv.tracklet_version_id,tv.tracklet_id,tv.version_no,
               atTime(tv.trajectory,$2::tstzspan) AS t,s.t AS subject_t,
               tv.max_accuracy_radius_m AS candidate_radius_m,s.radius_m AS subject_radius_m
        FROM unnest($3::uuid[]) AS ids(tracklet_version_id)
        JOIN gowm_stas_v1.tracklet_version tv USING (tracklet_version_id) CROSS JOIN subject s
      )
      SELECT tracklet_version_id,tracklet_id,version_no,
             eDwithin(t,subject_t,$4::double precision) IS TRUE AS nominal_exact_ever,
             CASE WHEN $5::text='CONSERVATIVE_BOUND'
                  THEN eDwithin(t,subject_t,$4::double precision+subject_radius_m+candidate_radius_m) IS TRUE
                  ELSE eDwithin(t,subject_t,$4::double precision) IS TRUE END AS possible_ever,
             CASE WHEN $5::text='CONSERVATIVE_BOUND'
                  THEN CASE WHEN $4::double precision-subject_radius_m-candidate_radius_m < 0 THEN false
                            ELSE eDwithin(t,subject_t,$4::double precision-subject_radius_m-candidate_radius_m) IS TRUE END
                  ELSE eDwithin(t,subject_t,$4::double precision) IS TRUE END AS definite_ever,
             t |=| subject_t AS minimum_distance_m,subject_radius_m,candidate_radius_m
      FROM c WHERE t IS NOT NULL AND subject_t IS NOT NULL
        AND CASE WHEN $5::text='CONSERVATIVE_BOUND'
                 THEN eDwithin(t,subject_t,$4::double precision+subject_radius_m+candidate_radius_m) IS TRUE
                 ELSE eDwithin(t,subject_t,$4::double precision) IS TRUE END
      ORDER BY tracklet_version_id
    `, [version.tracklet_version_id, toMobilitySpan(input.timeRange), ids, input.maxDistanceMeters, input.uncertaintyPolicy]);
    return {
      status: 'COMPLETE', result: { items: exact.rows }, subjects: [subject(version)],
      snapshot: { ...baseSnapshot([version]), trackletVersions: [...baseSnapshot([version]).trackletVersions, ...candidates.rows.map((row) => ({ trackletId: row.tracklet_id, trackletVersionId: row.tracklet_version_id, versionNo: row.version_no }))] },
      coverage: { requestedTime: input.timeRange }, algorithm: 'stbox-candidate-then-edwithin-v1', sqlTemplateId: 'find_nearby_tracklets.v1',
      candidateCount: ids.length, exactCount: exact.rows.length, uncertaintyPolicy: input.uncertaintyPolicy,
      page: { returned: exact.rows.length, truncated: false },
      warnings: [],
    };
  }

  private async findSuccessorCandidates(input: FindSuccessorCandidatesInput, transaction: Transaction): Promise<RepositoryExecution> {
    const predecessor = await this.resolveTracklet(input.dataScopeId, input.predecessor, transaction);
    if (input.uncertaintyPolicy === 'CONSERVATIVE_BOUND' && predecessor.max_accuracy_radius_m === null) {
      throw new AppError('UNSUPPORTED_UNCERTAINTY_MODEL', 422, 'Predecessor bound unavailable', 'Conservative successor discovery requires a hard endpoint error radius.');
    }
    let maximumRadius = input.maxSpeedMps * input.maxGapSeconds;
    if (input.uncertaintyPolicy === 'CONSERVATIVE_BOUND') {
      const eligibleBounds = await transaction.query<{ has_unknown: boolean; maximum_radius_m: number | null }>(`
        SELECT bool_or(tv.start_accuracy_radius_m IS NULL) AS has_unknown,
               max(tv.start_accuracy_radius_m) AS maximum_radius_m
          FROM gowm_stas_v1.tracklet t JOIN gowm_stas_v1.tracklet_head h ON h.tracklet_id=t.tracklet_id
          JOIN gowm_stas_v1.tracklet_version tv ON tv.tracklet_version_id=h.current_version_id
          JOIN gowm_stas_v1.source src ON src.source_id=t.source_id
          WHERE t.data_scope_id=$1::uuid AND t.analysis_space_id=$2::uuid AND t.tracklet_id<>$3::uuid
            AND (cardinality($4::text[])=0 OR src.source_type=ANY($4::text[]))
      `, [input.dataScopeId, predecessor.analysis_space_id, predecessor.tracklet_id, input.sourceTypes]);
      if (eligibleBounds.rows[0]?.has_unknown === true) {
        throw new AppError('UNSUPPORTED_UNCERTAINTY_MODEL', 422, 'Candidate bound unavailable', 'At least one eligible successor lacks a hard start-position error radius.');
      }
      maximumRadius += (predecessor.max_accuracy_radius_m ?? 0) + (eligibleBounds.rows[0]?.maximum_radius_m ?? 0);
    }
    const candidates = await transaction.query<{ tracklet_version_id: string; tracklet_id: string; version_no: number }>(`
      WITH pred AS (
        SELECT tv.tracklet_id,t.analysis_space_id,tv.end_time_lower,tv.end_time_upper,tv.end_position
        FROM gowm_stas_v1.tracklet_version tv JOIN gowm_stas_v1.tracklet t USING (tracklet_id)
        WHERE tv.tracklet_version_id=$1::uuid AND t.data_scope_id=$2::uuid
      )
      SELECT b.tracklet_version_id,b.tracklet_id,b.version_no
      FROM pred p
      JOIN gowm_stas_v1.tracklet t ON t.data_scope_id=$2::uuid AND t.analysis_space_id=p.analysis_space_id AND t.tracklet_id<>p.tracklet_id
      JOIN gowm_stas_v1.tracklet_head h ON h.tracklet_id=t.tracklet_id
      JOIN gowm_stas_v1.tracklet_version b ON b.tracklet_version_id=h.current_version_id
      JOIN gowm_stas_v1.source src ON src.source_id=t.source_id
      WHERE (cardinality($3::text[])=0 OR src.source_type=ANY($3::text[]))
        AND b.start_time_upper>p.end_time_lower
        AND b.start_time_lower<=p.end_time_upper+make_interval(secs=>$4::double precision)
        AND b.start_position && ST_Expand(p.end_position,$5::double precision)
      ORDER BY b.tracklet_version_id LIMIT $6::integer
    `, [predecessor.tracklet_version_id, input.dataScopeId, input.sourceTypes, input.maxGapSeconds, maximumRadius, input.limit + 1]);
    if (candidates.rows.length > input.limit) {
      throw new AppError('TOO_MANY_CANDIDATES', 422, 'Too many successor candidates', 'The complete coarse successor set exceeds the synchronous cap.', {
        cap: input.limit,
        observedAtLeast: input.limit + 1,
      });
    }
    if (candidates.rows.length === 0) {
      return {
        status: 'COMPLETE', result: { items: [] }, subjects: [subject(predecessor)], snapshot: baseSnapshot([predecessor]),
        algorithm: 'uncertainty-expanded-successor-filter-v1', sqlTemplateId: 'find_successor_candidates.v1', candidateCount: 0,
        page: { returned: 0, truncated: false },
      };
    }
    const ids = candidates.rows.map((candidate) => candidate.tracklet_version_id);
    const rows = await transaction.query(`
      WITH p AS (
        SELECT end_event_time,end_time_lower,end_time_upper,end_position,end_speed_mps,end_heading_rad,
               end_accuracy_radius_m
        FROM gowm_stas_v1.tracklet_version WHERE tracklet_version_id=$1::uuid
      )
      SELECT b.tracklet_version_id,b.tracklet_id,b.version_no,
             extract(epoch FROM (b.start_event_time-p.end_event_time)) AS nominal_delta_t_seconds,
             extract(epoch FROM (b.start_time_lower-p.end_time_upper)) AS minimum_delta_t_seconds,
             extract(epoch FROM (b.start_time_upper-p.end_time_lower)) AS maximum_delta_t_seconds,
             ST_Distance(b.start_position,p.end_position) AS nominal_distance_m,
             ST_Distance(b.start_position,p.end_position)/NULLIF(extract(epoch FROM (b.start_event_time-p.end_event_time)),0) AS required_speed_mps,
             b.start_speed_mps,p.end_speed_mps,b.start_heading_rad,p.end_heading_rad,
             b.start_accuracy_radius_m,p.end_accuracy_radius_m
      FROM unnest($2::uuid[]) ids(tracklet_version_id)
      JOIN gowm_stas_v1.tracklet_version b USING (tracklet_version_id) CROSS JOIN p
      ORDER BY b.tracklet_version_id
    `, [predecessor.tracklet_version_id, ids]);
    const evaluated = rows.rows.map((row) => {
      const nominalDt = Number(row.nominal_delta_t_seconds);
      const minDt = Number(row.minimum_delta_t_seconds);
      const maxDt = Number(row.maximum_delta_t_seconds);
      const distance = Number(row.nominal_distance_m);
      const nominalSpeed = Number(row.required_speed_mps);
      const radiusA = row.end_accuracy_radius_m === null ? null : Number(row.end_accuracy_radius_m);
      const radiusB = row.start_accuracy_radius_m === null ? null : Number(row.start_accuracy_radius_m);
      const radiusSum = radiusA === null || radiusB === null ? null : radiusA + radiusB;
      const distanceLow = radiusSum === null ? null : Math.max(0, distance - radiusSum);
      const distanceHigh = radiusSum === null ? null : distance + radiusSum;
      const requiredSpeedLow = distanceLow === null || maxDt <= 0 ? null : distanceLow / maxDt;
      const requiredSpeedHigh = distanceHigh === null || minDt <= 0 ? null : distanceHigh / minDt;
      const violations: string[] = [];
      let status: 'REACHABLE' | 'UNREACHABLE' | 'AMBIGUOUS';
      if (input.uncertaintyPolicy === 'CONSERVATIVE_BOUND') {
        if (radiusSum === null) {
          status = 'AMBIGUOUS';
          violations.push('POSITION_BOUND_NOT_EVALUABLE');
        } else if (maxDt <= 0) {
          status = 'UNREACHABLE';
          violations.push('NON_POSITIVE_TIME_SEPARATION_FOR_ALL_BOUNDS');
        } else if (minDt > input.maxGapSeconds) {
          status = 'UNREACHABLE';
          violations.push('MAX_GAP_EXCEEDED_FOR_ALL_BOUNDS');
        } else if (requiredSpeedLow !== null && requiredSpeedLow > input.maxSpeedMps) {
          status = 'UNREACHABLE';
          violations.push('MAX_SPEED_EXCEEDED_FOR_ALL_BOUNDS');
        } else if (minDt > 0 && maxDt <= input.maxGapSeconds
                   && requiredSpeedHigh !== null && requiredSpeedHigh <= input.maxSpeedMps) {
          status = 'REACHABLE';
        } else {
          status = 'AMBIGUOUS';
        }
      } else if (nominalDt <= 0) {
        status = 'UNREACHABLE';
        violations.push('NON_POSITIVE_NOMINAL_TIME_SEPARATION');
      } else if (nominalDt > input.maxGapSeconds) {
        status = 'UNREACHABLE';
        violations.push('MAX_GAP_EXCEEDED_NOMINAL');
      } else if (!Number.isFinite(nominalSpeed) || nominalSpeed > input.maxSpeedMps) {
        status = 'UNREACHABLE';
        violations.push('MAX_SPEED_EXCEEDED_NOMINAL');
      } else {
        status = 'REACHABLE';
      }
      if (input.reachabilityLevel === 2) {
        const startSpeed = row.start_speed_mps === null ? null : Number(row.start_speed_mps);
        const endSpeed = row.end_speed_mps === null ? null : Number(row.end_speed_mps);
        const startHeading = row.start_heading_rad === null ? null : Number(row.start_heading_rad);
        const endHeading = row.end_heading_rad === null ? null : Number(row.end_heading_rad);
        let level2NominalViolation = false;
        let level2NotEvaluable = false;
        if (startSpeed === null || endSpeed === null || nominalDt <= 0) {
          violations.push('ACCELERATION_NOT_EVALUABLE');
          level2NotEvaluable = true;
        } else if (Math.abs(startSpeed - endSpeed) / nominalDt > (input.maxAccelerationMps2 ?? 0)) {
          violations.push('MAX_ACCELERATION_EXCEEDED_NOMINAL');
          level2NominalViolation = true;
        }
        if (startHeading === null || endHeading === null) {
          violations.push('HEADING_NOT_EVALUABLE');
          level2NotEvaluable = true;
        } else {
          const difference = Math.abs(Math.atan2(Math.sin(startHeading - endHeading), Math.cos(startHeading - endHeading))) * 180 / Math.PI;
          if (difference > (input.maxHeadingDeltaDegrees ?? 0)) {
            violations.push('MAX_HEADING_DELTA_EXCEEDED_NOMINAL');
            level2NominalViolation = true;
          }
        }
        if (input.uncertaintyPolicy === 'CONSERVATIVE_BOUND') {
          if (status !== 'UNREACHABLE') status = 'AMBIGUOUS';
          violations.push('LEVEL2_KINEMATICS_NOMINAL_ONLY_UNDER_UNCERTAINTY');
        } else if (status !== 'UNREACHABLE' && level2NominalViolation) {
          status = 'UNREACHABLE';
        } else if (status === 'REACHABLE' && level2NotEvaluable) {
          status = 'AMBIGUOUS';
        }
      }
      return {
        ...row,
        distanceMeters: distance,
        distanceBoundsMeters: distanceLow === null ? null : { lower: distanceLow, upper: distanceHigh },
        deltaTBoundsSeconds: { lower: minDt, upper: maxDt },
        requiredSpeedBoundsMps: requiredSpeedLow === null ? null : { lower: requiredSpeedLow, upper: requiredSpeedHigh },
        constraintViolations: violations,
        reachability: status,
      };
    });
    return {
      status: 'COMPLETE', result: { items: evaluated }, subjects: [subject(predecessor)],
      snapshot: { ...baseSnapshot([predecessor]), trackletVersions: [...baseSnapshot([predecessor]).trackletVersions, ...candidates.rows.map((row) => ({ trackletId: row.tracklet_id, trackletVersionId: row.tracklet_version_id, versionNo: row.version_no }))] },
      algorithm: input.uncertaintyPolicy === 'CONSERVATIVE_BOUND' ? 'uncertainty-expanded-successor-filter-and-kinematics-v1' : 'nominal-successor-filter-and-kinematics-v1', sqlTemplateId: 'find_successor_candidates.v1',
      candidateCount: candidates.rows.length, exactCount: evaluated.length, page: { returned: evaluated.length, truncated: false },
      uncertaintyPolicy: input.uncertaintyPolicy,
      warnings: input.uncertaintyPolicy === 'NOMINAL'
        ? [{ code: 'NOMINAL_CANDIDATE_SET', message: 'Position uncertainty is not included in candidate completeness; possible physical successors may be absent.' }]
        : [],
    };
  }

  private async comparePairFeatures(input: ComparePairFeaturesInput, transaction: Transaction): Promise<RepositoryExecution> {
    const [a, b] = await this.resolvePair(input.dataScopeId, input.trackletA, input.trackletB, transaction);
    const threshold = input.thresholds.proximityMeters[0];
    const rows = await transaction.query(`
      WITH p AS (
        SELECT atTime(a.trajectory,$3::tstzspan) AS ta,atTime(b.trajectory,$3::tstzspan) AS tb
        FROM gowm_stas_v1.tracklet_version a,gowm_stas_v1.tracklet_version b
        WHERE a.tracklet_version_id=$1::uuid AND b.tracklet_version_id=$2::uuid
      ), common_domain AS (
        SELECT ta,tb,(getTime(ta) * getTime(tb)) AS common_time
        FROM p WHERE ta IS NOT NULL AND tb IS NOT NULL
      )
      SELECT ta |=| tb AS minimum_distance_m,
             getTime(ta)::text AS coverage_a,getTime(tb)::text AS coverage_b,
             common_time::text AS common_time,
             whenTrue(tDwithin(ta,tb,$4::double precision))::text AS proximity_times
      FROM common_domain WHERE common_time IS NOT NULL
    `, [a.tracklet_version_id, b.tracklet_version_id, toMobilitySpan(input.timeRange), threshold]);
    const row = rows.rows[0];
    const hasDefinedDistance = row !== undefined
      && row.minimum_distance_m !== null
      && row.minimum_distance_m !== undefined;
    if (!hasDefinedDistance) {
      return {
        status: 'NO_DATA', result: null, subjects: [subject(a), subject(b)], snapshot: baseSnapshot([a, b]),
        coverage: { requestedTime: input.timeRange }, algorithm: 'pair-feature-bundle-v1', sqlTemplateId: 'compare_pair_features.v1',
      };
    }
    const minimumDistance = Number(row.minimum_distance_m);
    const features: Record<string, unknown> = {};
    if (input.features.includes('TEMPORAL_OVERLAP')) features.TEMPORAL_OVERLAP = { value: row.common_time, unit: 'time-domain' };
    if (input.features.includes('MIN_DISTANCE')) features.MIN_DISTANCE = { value: minimumDistance, unit: 'm' };
    if (input.features.includes('PROXIMITY_DURATION')) features.PROXIMITY_DURATION = { value: row.proximity_times, thresholdMeters: threshold };
    if (input.features.includes('GAP_CONTEXT')) features.GAP_CONTEXT = { coverageA: row.coverage_a, coverageB: row.coverage_b };
    return {
      status: 'COMPLETE', result: { features }, subjects: [subject(a), subject(b)],
      snapshot: baseSnapshot([a, b]), coverage: { requestedTime: input.timeRange },
      algorithm: 'pair-feature-bundle-v1', sqlTemplateId: 'compare_pair_features.v1',
      uncertainties: conservativeDistanceUncertainty(minimumDistance, a, b),
      warnings: [],
    };
  }

  private async findSensorCoverage(input: FindSensorCoverageInput, transaction: Transaction): Promise<RepositoryExecution> {
    let coverageRegion: ResolvedRegion | undefined;
    if (input.point !== undefined) {
      const metadata = await transaction.runtimeMetadata();
      if (input.point.srid !== metadata.analysisSrid) {
        throw new AppError('CRS_MISMATCH', 422, 'Coverage point CRS mismatch', `point.srid must equal the deployment analysis SRID ${metadata.analysisSrid}.`);
      }
    }
    if (input.spatialObjectVersionId !== undefined) {
      coverageRegion = await this.resolveRegion(input.dataScopeId, {
        spatialObjectVersionId: input.spatialObjectVersionId,
      }, transaction);
    }
    if (input.sensorId !== undefined) await this.assertSensorRef(input.dataScopeId, input.sensorId, transaction);

    // Phase A: indexable scope/time/metadata + bounding-box candidate discovery.
    // No exact spatial predicate, status expansion, or watermark join is allowed before cap+1.
    const candidateRows = await transaction.query<{ coverage_slice_id: string }>(`
      WITH query_region AS (
        SELECT CASE
          WHEN $4::uuid IS NOT NULL THEN (SELECT sov.geometry FROM gowm_stas_v1.spatial_object_version sov JOIN gowm_stas_v1.spatial_object so USING (spatial_object_id) WHERE sov.spatial_object_version_id=$4::uuid AND so.data_scope_id=$1::uuid)
          WHEN $5::double precision IS NOT NULL THEN ST_SetSRID(ST_MakePoint($5,$6),$7::integer)
          ELSE NULL END AS geometry
      )
      SELECT cs.coverage_slice_id
      FROM gowm_stas_v1.sensor_coverage_slice cs
      JOIN gowm_stas_v1.sensor_deployment sd USING (sensor_deployment_id)
      JOIN gowm_stas_v1.sensor s USING (sensor_id)
      CROSS JOIN query_region qr
      WHERE cs.data_scope_id=$1::uuid
        AND cs.valid_time && tstzrange($2::timestamptz,$3::timestamptz,'[)')
        AND ($8::uuid IS NULL OR s.sensor_id=$8::uuid)
        AND ($9::text IS NULL OR cs.detectable_object_class=$9::text)
        AND ($11::uuid IS NULL OR sd.analysis_space_id=$11::uuid)
        AND (qr.geometry IS NULL OR cs.coverage_geometry && qr.geometry)
      ORDER BY lower(cs.valid_time),cs.coverage_slice_id LIMIT $10::integer
    `, [
      input.dataScopeId, input.timeRange.start, input.timeRange.end, input.spatialObjectVersionId ?? null,
      input.point?.x ?? null, input.point?.y ?? null, input.point?.srid ?? null, input.sensorId ?? null,
      input.objectClass ?? null, input.limit + 1, coverageRegion?.analysis_space_id ?? null,
    ]);
    if (candidateRows.rows.length > input.limit) {
      throw new AppError('TOO_MANY_CANDIDATES', 422, 'Too many coverage candidates', 'The complete bounding-box candidate set exceeds the synchronous cap.', {
        cap: input.limit,
        observedAtLeast: input.limit + 1,
      });
    }
    const candidateIds = candidateRows.rows.map((row) => row.coverage_slice_id);
    if (candidateIds.length === 0) {
      return {
        status: 'COMPLETE', result: { items: [] },
        subjects: input.sensorId === undefined ? [] : [{ kind: 'SENSOR', id: input.sensorId }],
        snapshot: { trackletVersions: [], coverageSliceIds: [], ...(input.spatialObjectVersionId === undefined ? {} : { spatialObjectVersionIds: [input.spatialObjectVersionId] }) },
        coverage: { requestedTime: input.timeRange }, algorithm: 'coverage-bbox-cap-then-exact-v1', sqlTemplateId: 'find_sensor_coverage.v1',
        candidateCount: 0, exactCount: 0, page: { returned: 0, truncated: false },
        warnings: [{ code: 'NOT_NEGATIVE_EVIDENCE', message: 'An empty coverage query does not by itself prove that a target was absent.' }],
      };
    }

    // Phase B: exact point/region predicate and evidence enrichment over frozen IDs only.
    const rows = await transaction.query(`
      WITH query_region AS (
        SELECT CASE
          WHEN $2::uuid IS NOT NULL THEN (SELECT sov.geometry FROM gowm_stas_v1.spatial_object_version sov JOIN gowm_stas_v1.spatial_object so USING (spatial_object_id) WHERE sov.spatial_object_version_id=$2::uuid AND so.data_scope_id=$3::uuid)
          WHEN $4::double precision IS NOT NULL THEN ST_SetSRID(ST_MakePoint($4,$5),$6::integer)
          ELSE NULL END AS geometry
      )
      SELECT cs.coverage_slice_id,cs.sensor_deployment_id,cs.valid_time::text AS valid_time,
             ST_AsGeoJSON(cs.coverage_geometry)::jsonb AS coverage_geometry,
             cs.datastream_id,cs.detectable_object_class,cs.coverage_confidence,cs.coverage_model_version,
             cs.occlusion_model_version,cs.assumptions,cs.sensor_pose_version_id,
             cs.sensor_extrinsic_version_id,cs.detector_model_id,cs.processing_run_id,
             CASE WHEN status_evidence.status_interval_ids IS NULL THEN 'MISSING_STATUS'
                  WHEN status_evidence.has_active_status THEN 'ACTIVE_PRESENT'
                  ELSE 'NON_ACTIVE_ONLY' END AS prerequisite_state,
             CASE WHEN watermark_evidence.watermark_revision_ids IS NULL THEN 'MISSING_WATERMARK'
                  WHEN watermark_evidence.closed_through_requested_end THEN 'CLOSED_THROUGH_REQUESTED_END'
                  ELSE 'PINNED_NOT_CLOSED_THROUGH_REQUESTED_END' END AS watermark_state,
             status_evidence.status_intervals,status_evidence.status_interval_ids,
             watermark_evidence.watermarks,watermark_evidence.watermark_revision_ids
      FROM unnest($1::uuid[]) AS frozen(coverage_slice_id)
      JOIN gowm_stas_v1.sensor_coverage_slice cs USING (coverage_slice_id)
      JOIN gowm_stas_v1.sensor_deployment sd USING (sensor_deployment_id)
      JOIN gowm_stas_v1.sensor s USING (sensor_id)
      JOIN gowm_stas_v1.datastream ds ON ds.datastream_id=cs.datastream_id
      CROSS JOIN query_region qr
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
                 'sensorStatusId',ss.sensor_status_id,'validTime',ss.valid_time::text,
                 'captureState',ss.capture_state,'analyticState',ss.analytic_state,
                 'transportState',ss.transport_state,'completenessState',ss.completeness_state,
                 'calibrationState',ss.calibration_state,'clockHealth',ss.clock_health)
                 ORDER BY lower(ss.valid_time),ss.sensor_status_id) AS status_intervals,
               array_agg(ss.sensor_status_id ORDER BY lower(ss.valid_time),ss.sensor_status_id) AS status_interval_ids
              ,bool_or(ss.capture_state='ACTIVE') AS has_active_status
        FROM gowm_stas_v1.sensor_status_interval ss
        WHERE ss.sensor_deployment_id=cs.sensor_deployment_id AND ss.valid_time && cs.valid_time
          AND ss.valid_time && tstzrange($9::timestamptz,$10::timestamptz,'[)')
          AND (ss.producer_pipeline_id IS NULL OR ss.producer_pipeline_id=ds.producer_pipeline_id)
      ) status_evidence ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
                 'watermarkRevisionId',latest.watermark_revision_id,
                 'closedThroughEventTime',latest.closed_through_event_time,
                 'allowedLateness',latest.allowed_lateness::text,
                 'completenessState',latest.completeness_state)) AS watermarks,
               array_agg(latest.watermark_revision_id) AS watermark_revision_ids,
               bool_and(latest.closed_through_event_time >= $10::timestamptz) AS closed_through_requested_end
        FROM LATERAL (
          SELECT w.* FROM gowm_stas_v1.pipeline_watermark_revision w
          WHERE w.datastream_id=cs.datastream_id
          ORDER BY w.created_at DESC,w.watermark_revision_id DESC LIMIT 1
        ) latest
      ) watermark_evidence ON true
      WHERE (qr.geometry IS NULL
          OR ($4::double precision IS NOT NULL AND ST_Covers(cs.coverage_geometry,qr.geometry))
          OR ($2::uuid IS NOT NULL AND ST_Intersects(cs.coverage_geometry,qr.geometry)))
        AND ($8::uuid IS NULL OR sd.analysis_space_id=$8::uuid)
        AND ($7::boolean
          OR NOT EXISTS (
            SELECT 1 FROM gowm_stas_v1.sensor_status_interval known
            WHERE known.sensor_deployment_id=cs.sensor_deployment_id AND known.valid_time && cs.valid_time
              AND known.valid_time && tstzrange($9::timestamptz,$10::timestamptz,'[)')
              AND (known.producer_pipeline_id IS NULL OR known.producer_pipeline_id=ds.producer_pipeline_id))
          OR EXISTS (
            SELECT 1 FROM gowm_stas_v1.sensor_status_interval active
            WHERE active.sensor_deployment_id=cs.sensor_deployment_id
              AND active.valid_time && cs.valid_time AND active.capture_state='ACTIVE'
              AND active.valid_time && tstzrange($9::timestamptz,$10::timestamptz,'[)')
              AND (active.producer_pipeline_id IS NULL OR active.producer_pipeline_id=ds.producer_pipeline_id))
        )
      ORDER BY lower(cs.valid_time),cs.coverage_slice_id
    `, [
      candidateIds, input.spatialObjectVersionId ?? null, input.dataScopeId,
      input.point?.x ?? null, input.point?.y ?? null, input.point?.srid ?? null, input.includeInactive,
      coverageRegion?.analysis_space_id ?? null,
      input.timeRange.start, input.timeRange.end,
    ]);
    const exactCoverageIds = rows.rows.map((row) => String(row.coverage_slice_id));
    const snapshot = {
      trackletVersions: [],
      coverageSliceIds: exactCoverageIds,
      datastreamIds: [...new Set(rows.rows.map((row) => String(row.datastream_id)))],
      sensorPoseVersionIds: rows.rows.flatMap((row) => row.sensor_pose_version_id === null ? [] : [String(row.sensor_pose_version_id)]),
      sensorExtrinsicVersionIds: rows.rows.flatMap((row) => row.sensor_extrinsic_version_id === null ? [] : [String(row.sensor_extrinsic_version_id)]),
      sensorStatusIntervalIds: rows.rows.flatMap((row) => Array.isArray(row.status_interval_ids) ? row.status_interval_ids.map(String) : []),
      detectorModelIds: rows.rows.flatMap((row) => row.detector_model_id === null ? [] : [String(row.detector_model_id)]),
      watermarkRevisionIds: rows.rows.flatMap((row) => Array.isArray(row.watermark_revision_ids) ? row.watermark_revision_ids.map(String) : []),
      processingRunIds: rows.rows.map((row) => String(row.processing_run_id)),
      ...(input.spatialObjectVersionId === undefined ? {} : { spatialObjectVersionIds: [input.spatialObjectVersionId] }),
    };
    return {
      status: 'COMPLETE', result: { items: rows.rows }, subjects: input.sensorId === undefined ? [] : [{ kind: 'SENSOR', id: input.sensorId }],
      snapshot, coverage: { requestedTime: input.timeRange }, algorithm: 'coverage-bbox-cap-then-exact-status-watermark-v1', sqlTemplateId: 'find_sensor_coverage.v1',
      candidateCount: candidateIds.length, exactCount: rows.rows.length,
      page: { returned: rows.rows.length, truncated: false },
      warnings: [
        { code: 'CANDIDATE_UNIVERSE_FROZEN', message: `${candidateIds.length} bounding-box candidate IDs were frozen before exact evaluation; only exact matches are evidence references.` },
        { code: 'MISSING_STATUS_IS_UNKNOWN', message: 'Coverage slices with no overlapping status record are retained; missing status is not treated as inactive.' },
        { code: 'NOT_NEGATIVE_EVIDENCE', message: 'Coverage prerequisites do not by themselves prove EXPECTED_BUT_NOT_DETECTED.' },
      ],
    };
  }
}
