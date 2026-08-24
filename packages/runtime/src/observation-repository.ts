import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  CanonicalMeasurementInput,
  CanonicalObservationBundle,
  ObservationEnvelope,
  WorldEvent
} from "../../world-model-core/src/types.js";
import { loadConfig } from "../../world-model-core/src/config.js";
import { canonicalJson } from "../../observation-model/src/canonical.js";
import { createWorldEvent } from "../../event-model/src/events.js";
import { mapObservation } from "./row-mappers.js";
import { insertEvent } from "./world-repository.js";
import { withTransaction } from "./db.js";

export interface ObservationInsertResult {
  status: "accepted" | "duplicate" | "late";
  observation: ObservationEnvelope;
  event?: WorldEvent;
  timeSolutionId?: string;
  measurementIds?: string[];
  trackletVersionId?: string;
}

const OBSERVATION_SELECT = `
  SELECT *, CASE WHEN geometry IS NULL THEN NULL ELSE ST_AsGeoJSON(geometry)::jsonb END AS geometry_json
  FROM world_observation`;

export class ObservationRepository {
  private readonly config = loadConfig();

  constructor(private readonly pool: pg.Pool) {}

  async insert(
    bundle: CanonicalObservationBundle,
    disposition: { status?: "accepted" | "late"; project?: boolean; rejectionReason?: string } = {}
  ): Promise<ObservationInsertResult> {
    return withTransaction(this.pool, async (client) => {
      const foundation = await this.ensureFoundation(client, bundle);
      const observation = bundle.envelope;
      const result = await client.query<{ observation_id: string }>(
        `INSERT INTO world_observation (
           observation_id,observer_type,observer_id,subject_type,subject_id,observation_type,
           geometry,altitude,value,confidence,observed_at,received_at,source,correlation_id,
           metadata,schema_version,status,rejection_reason,data_scope_key,source_record_key,
           source_revision_no,supersedes_observation_id,origin_kind,source_local_target_id,
           tracker_session_id,datastream_key,producer_pipeline_key,source_time_raw,source_time_ticks,
           source_time_value,result_time,source_emitted_time,upstream_received_time,source_processed_time,raw_reference,
           payload_hash,quality_flags,entity_binding_status,
           execution_intent_id,operation_correlation_id,external_planning_task_id,
           external_planning_step_id,provider_action_id,device_command_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,
           CASE WHEN $7::jsonb IS NULL THEN NULL ELSE ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($7::jsonb)),4326) END,
           $8,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24,
           $25,$26,$27,$28,$29::numeric,$30,$31,$32,$33,$34,$35,$36,$37::text[],$38,
           $39,$40,$41,$42,$43,$44
         ) ON CONFLICT DO NOTHING RETURNING observation_id`,
        [
          observation.observationId,observation.observer.type,observation.observer.id,
          observation.subject.type,observation.subject.id,observation.observationType,
          observation.geometry ? JSON.stringify(observation.geometry) : null,
          observation.geometry?.type === "Point" ? observation.geometry.coordinates[2] ?? null : null,
          JSON.stringify(observation.value),observation.confidence,observation.observedAt,
          observation.receivedAt,observation.source,observation.correlationId,
          JSON.stringify(observation.metadata),observation.schemaVersion,
          disposition.status ?? "accepted",disposition.rejectionReason ?? null,
          bundle.dataScopeKey,bundle.sourceRecordKey,bundle.sourceRevisionNo,
          bundle.supersedesObservationId ?? null,bundle.originKind,bundle.sourceLocalTargetId,
          bundle.trackerSessionId ?? null,bundle.datastreamKey,bundle.producerPipelineKey,
          bundle.timeSolution.sourceTimeRaw ?? null,bundle.timeSolution.sourceTimeTicks ?? null,
          bundle.timeSolution.sourceTime ?? null,bundle.timeSolution.resultTime ?? null,
          bundle.timeSolution.sourceEmittedTime ?? null,bundle.timeSolution.upstreamReceivedTime ?? null,
          bundle.timeSolution.processedTime ?? null,bundle.rawReference,bundle.payloadHash,
          bundle.qualityFlags,bundle.entityBindingStatus,
          bundle.executionIntentId ?? null,bundle.operationCorrelationId ?? null,
          bundle.externalPlanningTaskId ?? null,bundle.externalPlanningStepId ?? null,
          bundle.providerActionId ?? null,bundle.deviceCommandId ?? null
        ]
      );

      if (!result.rowCount) {
        const existing = await client.query(
          `${OBSERVATION_SELECT}
           WHERE observation_id=$1 OR (source=$2 AND source_record_key=$3 AND source_revision_no=$4)
              OR (source=$2 AND source_record_key=$3 AND payload_hash=$5)
           ORDER BY (observation_id=$1) DESC LIMIT 1`,
          [observation.observationId,observation.source,bundle.sourceRecordKey,bundle.sourceRevisionNo,bundle.payloadHash]
        );
        const row = existing.rows[0] as Record<string, unknown> | undefined;
        if (row && String(row.payload_hash) !== bundle.payloadHash) {
          throw Object.assign(new Error("idempotency conflict: immutable canonical payload differs"), {
            statusCode: 409,
            code: "IDEMPOTENCY_CONFLICT"
          });
        }
        if (!row) throw new Error("observation insert conflicted but no immutable identity could be resolved");
        const existingObservationId = String(row.observation_id);
        const refs = await client.query<{ time_solution_id: string; measurement_ids: string[] }>(
          `SELECT ts.time_solution_id,array_agg(m.measurement_id::text ORDER BY m.measurement_id)::text[] AS measurement_ids
           FROM observation_time_solution ts JOIN measurement m ON m.time_solution_id=ts.time_solution_id
           WHERE ts.observation_id=$1 GROUP BY ts.time_solution_id,ts.created_at
           ORDER BY ts.created_at DESC LIMIT 1`,[existingObservationId]
        );
        const tracklet = await client.query<{ tracklet_version_id: string }>(
          `SELECT h.current_version_id AS tracklet_version_id
           FROM mobility_tracklet t JOIN mobility_tracklet_head h ON h.tracklet_id=t.tracklet_id
           WHERE t.data_scope_key=$1 AND t.source_key=$2 AND t.source_local_target_id=$3
             AND t.tracker_session_key=$4
           ORDER BY h.updated_at DESC,t.tracklet_id LIMIT 1`,
          [bundle.dataScopeKey,observation.source,bundle.sourceLocalTargetId,bundle.trackerSessionId ?? "__UNSCOPED__"]
        );
        return {
          status: "duplicate",observation: mapObservation(row),
          ...(refs.rows[0]?.time_solution_id ? { timeSolutionId: refs.rows[0].time_solution_id } : {}),
          measurementIds: refs.rows[0]?.measurement_ids ?? [],
          ...(tracklet.rows[0]?.tracklet_version_id ? { trackletVersionId: tracklet.rows[0].tracklet_version_id } : {})
        };
      }

      const timeSolutionId = await this.insertTimeSolution(client,bundle,foundation.clockModelId,foundation.processingRunId);
      const measurementIds = await this.insertMeasurements(client,bundle,timeSolutionId,foundation.processingRunId);
      await this.insertAssertions(client,bundle,timeSolutionId,foundation.processingRunId,measurementIds);

      await client.query(
        `INSERT INTO world_observation_head(source_key,source_record_key,current_observation_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (source_key,source_record_key) DO UPDATE SET
           current_observation_id=EXCLUDED.current_observation_id,updated_at=clock_timestamp()
         WHERE (SELECT source_revision_no FROM world_observation WHERE observation_id=EXCLUDED.current_observation_id) >
               (SELECT source_revision_no FROM world_observation WHERE observation_id=world_observation_head.current_observation_id)`,
        [observation.source,bundle.sourceRecordKey,observation.observationId]
      );

      await client.query(
        `INSERT INTO entity_binding(
           data_scope_key,source_key,source_local_target_id,tracker_session_key,world_object_id,binding_status,
           method,method_version,evidence_observation_id,confidence
         ) VALUES ($1,$2,$3,$4,(SELECT id FROM world_object WHERE id=$5),$6,$7,'1.2.0',$8,$9)
         ON CONFLICT DO NOTHING`,
        [bundle.dataScopeKey,observation.source,bundle.sourceLocalTargetId,
         bundle.trackerSessionId ?? "__UNSCOPED__",observation.subject.id,
         bundle.entityBindingStatus,"CANONICAL_OBSERVATION_SUBJECT",observation.observationId,observation.confidence]
      );

      let trackletVersionId: string | undefined;
      const positionMeasurements = bundle.measurements.filter((measurement) => measurement.resultKind === "POSITION");
      if (positionMeasurements.length) {
        const spaces = [...new Set(positionMeasurements.map((measurement) => measurement.analysisSpaceKey ?? this.config.analysisSpaceKey))];
        for (const space of spaces) {
          const rebuilt = await client.query<{ version_id: string | null }>(
            `SELECT gowm_rebuild_mobility_tracklet($1,$2,$3,$4,$5) AS version_id`,
            [bundle.dataScopeKey,observation.source,bundle.sourceLocalTargetId,
             bundle.trackerSessionId ?? "__UNSCOPED__",space]
          );
          trackletVersionId = rebuilt.rows[0]?.version_id ?? trackletVersionId;
        }
      }

      if (disposition.project !== false && bundle.entityBindingStatus !== "CANDIDATE") {
        await client.query("INSERT INTO projection_queue(observation_id) VALUES ($1)", [observation.observationId]);
      }

      const versionResult = await client.query<{ value: string }>("SELECT last_value::text AS value FROM world_version_seq");
      const event = createWorldEvent({
        eventType: "ObservationReceived",
        subject: observation.subject,
        worldVersion: Number(versionResult.rows[0]?.value ?? 0),
        correlationId: observation.correlationId,
        causationId: observation.observationId,
        ...(observation.geometry ? { geometry: observation.geometry } : {}),
        timestamp: observation.receivedAt,
        dataScopeKey: bundle.dataScopeKey,
        ...externalCorrelationFields(bundle),
        payload: {
          observationId: observation.observationId,
          observer: observation.observer,
          observationType: observation.observationType,
          confidence: observation.confidence,
          source: observation.source,
          phenomenonTime: observation.observedAt,
          timeSolutionId,
          measurementIds: [...measurementIds.values()],
          trackletVersionId,
          inputSchemaVersion: observation.schemaVersion,
          canonicalContractVersion: "1.2"
        }
      });
      await insertEvent(client,event);
      return {
        status: disposition.status ?? "accepted",
        observation,
        event,
        timeSolutionId,
        measurementIds: [...measurementIds.values()],
        ...(trackletVersionId ? { trackletVersionId } : {})
      };
    });
  }

  private async ensureFoundation(client: pg.PoolClient,bundle: CanonicalObservationBundle): Promise<{
    processingRunId: string;
    clockModelId: string;
  }> {
    const domain = bundle.dataScopeKey === "default" ? "TEST" : bundle.originKind === "SIMULATION" ? "SIMULATION" : "REAL";
    await client.query(
      `INSERT INTO data_scope(scope_key,operational_domain,description)
       VALUES ($1,$2,'Created by canonical observation ingest') ON CONFLICT DO NOTHING`,
      [bundle.dataScopeKey,domain]
    );
    const scope = await client.query<{ operational_domain: string }>(
      "SELECT operational_domain FROM data_scope WHERE scope_key=$1",[bundle.dataScopeKey]
    );
    if (scope.rows[0]?.operational_domain !== domain) {
      throw Object.assign(new Error(`dataScope ${bundle.dataScopeKey} cannot mix ${domain} with ${scope.rows[0]?.operational_domain}`), {
        statusCode: 409,code: "DATA_SCOPE_DOMAIN_CONFLICT"
      });
    }
    const positionSpaces = bundle.measurements
      .filter((measurement) => measurement.resultKind === "POSITION")
      .map((measurement) => ({ key: measurement.analysisSpaceKey ?? this.config.analysisSpaceKey, srid: measurement.position?.srid ?? this.config.analysisSrid }));
    if (!positionSpaces.length) positionSpaces.push({ key: this.config.analysisSpaceKey, srid: this.config.analysisSrid });
    for (const space of positionSpaces) {
      const registered = await client.query<{ valid: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM spatial_ref_sys
           WHERE srid=$1 AND srtext ~* '(PROJCS|PROJCRS)'
             AND (srtext ~* '(metre|meter)' OR proj4text ~ '(^|[[:space:]])\\+units=m([[:space:]]|$)')
         ) AS valid`,
        [space.srid]
      );
      if (!registered.rows[0]?.valid) {
        throw Object.assign(new Error(`analysisSpace ${space.key} requires a registered projected metre CRS`), {
          statusCode: 422, code: "INVALID_ANALYSIS_CRS"
        });
      }
      await client.query(
        `INSERT INTO analysis_space(analysis_space_key,canonical_srid,dimension_model,distance_model,transform_pipeline_version)
         VALUES ($1,$2,'2D','PLANAR_METRE_V1','canonical-input-v1.2') ON CONFLICT DO NOTHING`,
        [space.key,space.srid]
      );
      const existing = await client.query<{ canonical_srid: number }>(
        "SELECT canonical_srid FROM analysis_space WHERE analysis_space_key=$1",
        [space.key]
      );
      if (existing.rows[0]?.canonical_srid !== space.srid) {
        throw Object.assign(new Error(`analysisSpace ${space.key} SRID mismatch`), { statusCode: 422, code: "ANALYSIS_SPACE_MISMATCH" });
      }
    }
    const defaultSpace = positionSpaces[0]?.key ?? this.config.analysisSpaceKey;
    await client.query(
      `INSERT INTO source_registry(source_key,data_scope_key,source_type,default_analysis_space_key)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [bundle.envelope.source,bundle.dataScopeKey,bundle.originKind,defaultSpace]
    );
    const sourceOwner = await client.query<{ data_scope_key: string; default_analysis_space_key: string }>(
      "SELECT data_scope_key,default_analysis_space_key FROM source_registry WHERE source_key=$1",
      [bundle.envelope.source]
    );
    if (sourceOwner.rows[0]?.data_scope_key !== bundle.dataScopeKey) {
      throw Object.assign(new Error(`source ${bundle.envelope.source} belongs to another data scope`), {
        statusCode: 409, code: "SOURCE_SCOPE_CONFLICT"
      });
    }
    await client.query(
      `INSERT INTO producer_pipeline(pipeline_key,source_key,pipeline_version,output_kind)
       VALUES ($1,$2,'1.2','CANONICAL_OBSERVATION') ON CONFLICT DO NOTHING`,
      [bundle.producerPipelineKey,bundle.envelope.source]
    );
    const pipelineOwner = await client.query<{ source_key: string }>(
      "SELECT source_key FROM producer_pipeline WHERE pipeline_key=$1",
      [bundle.producerPipelineKey]
    );
    if (pipelineOwner.rows[0]?.source_key !== bundle.envelope.source) {
      throw Object.assign(new Error(`pipeline ${bundle.producerPipelineKey} belongs to another source`), {
        statusCode: 409, code: "PIPELINE_SOURCE_CONFLICT"
      });
    }
    await client.query(
      `INSERT INTO datastream(datastream_key,source_key,data_scope_key,pipeline_key,schema_version)
       VALUES ($1,$2,$3,$4,'1.2') ON CONFLICT DO NOTHING`,
      [bundle.datastreamKey,bundle.envelope.source,bundle.dataScopeKey,bundle.producerPipelineKey]
    );
    const streamOwner = await client.query<{ source_key: string; data_scope_key: string; pipeline_key: string }>(
      "SELECT source_key,data_scope_key,pipeline_key FROM datastream WHERE datastream_key=$1",
      [bundle.datastreamKey]
    );
    if (streamOwner.rows[0]?.source_key !== bundle.envelope.source ||
        streamOwner.rows[0]?.data_scope_key !== bundle.dataScopeKey ||
        streamOwner.rows[0]?.pipeline_key !== bundle.producerPipelineKey) {
      throw Object.assign(new Error(`datastream ${bundle.datastreamKey} ownership mismatch`), {
        statusCode: 409, code: "DATASTREAM_OWNERSHIP_CONFLICT"
      });
    }
    const processingRunId = randomUUID();
    await client.query(
      `INSERT INTO processing_run(processing_run_id,processor_name,processor_version,config_hash,code_digest,deterministic,started_at,completed_at)
       VALUES ($1,'gowm-canonical-ingest','1.2.0',$2,$3,true,clock_timestamp(),clock_timestamp())`,
      [processingRunId,sha256(canonicalJson({ pipeline: bundle.producerPipelineKey, schema: "1.2" })),process.env.SERVICE_REVISION ?? "unversioned"]
    );
    await client.query(
      `INSERT INTO source_clock_model(
         source_key,model_version,clock_domain,offset_seconds,drift_ppm,residual_sigma_ms,
         estimation_method,calibration_reference,supersedes_clock_model_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (source_key,model_version) DO NOTHING`,
      [bundle.envelope.source,bundle.timeSolution.clockModelVersion,
       bundle.timeSolution.clockDomain ?? "SOURCE_DECLARED",bundle.timeSolution.clockOffsetSeconds ?? 0,
       bundle.timeSolution.clockDriftPpm ?? null,bundle.timeSolution.clockResidualSigmaMs ?? 0,
       bundle.timeSolution.clockEstimationMethod ?? bundle.timeSolution.correctionMethod,
       bundle.timeSolution.clockCalibrationReference ?? null,bundle.timeSolution.supersedesClockModelId ?? null]
    );
    const clock = await client.query<{
      clock_model_id: string; clock_domain: string; offset_seconds: number; drift_ppm: number | null;
      residual_sigma_ms: number; estimation_method: string; calibration_reference: string | null;
    }>(
      `SELECT clock_model_id,clock_domain,offset_seconds,drift_ppm,residual_sigma_ms,
              estimation_method,calibration_reference FROM source_clock_model
       WHERE source_key=$1 AND model_version=$2`,
      [bundle.envelope.source,bundle.timeSolution.clockModelVersion]
    );
    const clockModelId = clock.rows[0]?.clock_model_id;
    if (!clockModelId) throw new Error("clock model was not persisted");
    const expectedClock = {
      clockDomain: bundle.timeSolution.clockDomain ?? "SOURCE_DECLARED",
      offsetSeconds: bundle.timeSolution.clockOffsetSeconds ?? 0,
      driftPpm: bundle.timeSolution.clockDriftPpm ?? null,
      residualSigmaMs: bundle.timeSolution.clockResidualSigmaMs ?? 0,
      estimationMethod: bundle.timeSolution.clockEstimationMethod ?? bundle.timeSolution.correctionMethod,
      calibrationReference: bundle.timeSolution.clockCalibrationReference ?? null
    };
    const actualClock = {
      clockDomain: clock.rows[0]?.clock_domain,offsetSeconds: Number(clock.rows[0]?.offset_seconds),
      driftPpm: clock.rows[0]?.drift_ppm === null ? null : Number(clock.rows[0]?.drift_ppm),
      residualSigmaMs: Number(clock.rows[0]?.residual_sigma_ms),
      estimationMethod: clock.rows[0]?.estimation_method,
      calibrationReference: clock.rows[0]?.calibration_reference
    };
    if (canonicalJson(actualClock) !== canonicalJson(expectedClock)) {
      throw Object.assign(new Error(`clock model ${bundle.timeSolution.clockModelVersion} definition conflict`), {
        statusCode: 409, code: "CLOCK_MODEL_CONFLICT"
      });
    }
    return { processingRunId,clockModelId };
  }

  private async insertTimeSolution(
    client: pg.PoolClient,bundle: CanonicalObservationBundle,clockModelId: string,processingRunId: string
  ): Promise<string> {
    const time = bundle.timeSolution;
    const result = await client.query<{ time_solution_id: string }>(
      `INSERT INTO observation_time_solution(
         observation_id,clock_model_id,processing_run_id,supersedes_time_solution_id,
         phenomenon_time_estimate,phenomenon_time_window,exposure_or_scan_duration,
         uncertainty_seconds,solution_method
       ) VALUES ($1,$2,$3,$4,$5,span($6::timestamptz,$7::timestamptz,true,false),
                 CASE WHEN $8::double precision IS NULL THEN NULL ELSE make_interval(secs=>$8/1000.0) END,$9,$10)
       RETURNING time_solution_id`,
      [bundle.envelope.observationId,clockModelId,processingRunId,time.supersedesTimeSolutionId ?? null,
       time.phenomenonTimeEstimate,time.phenomenonTimeWindow.start,time.phenomenonTimeWindow.end,
       time.exposureOrScanDurationMs ?? null,time.uncertaintySeconds,time.correctionMethod]
    );
    const id = result.rows[0]?.time_solution_id;
    if (!id) throw new Error("time solution was not persisted");
    return id;
  }

  private async insertMeasurements(
    client: pg.PoolClient,bundle: CanonicalObservationBundle,timeSolutionId: string,processingRunId: string
  ): Promise<Map<string,string>> {
    const ids = new Map<string,string>();
    for (const measurement of bundle.measurements) {
      const measurementId = measurement.measurementId ?? randomUUID();
      await client.query(
        `INSERT INTO measurement(
           measurement_id,observation_id,time_solution_id,processing_run_id,measurement_key,
           measurement_stage,observed_property,result_kind,scalar_value,value_unit,vector_value,
           source_geometry,native_frame,measurement_model,measurement_model_version,calibration_version,
           algorithm_confidence,quality_score,quality_flags,continuity_token,manual_cut_before,
           attributes,command_fingerprint
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::double precision[],
           CASE WHEN $12::jsonb IS NULL THEN NULL ELSE ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($12::jsonb)),4326) END,
           $13,$14,$15,$16,$17,$18,$19::text[],$20,$21,$22::jsonb,$23)`,
        [measurementId,bundle.envelope.observationId,timeSolutionId,processingRunId,measurement.measurementKey,
         measurement.measurementStage,measurement.observedProperty,measurement.resultKind,
         measurement.scalarValue ?? null,measurement.valueUnit ?? null,measurement.vectorValue ?? null,
         measurement.sourceGeometry ? JSON.stringify(measurement.sourceGeometry) : null,
         measurement.nativeFrame ?? null,measurement.measurementModel,measurement.measurementModelVersion,
         measurement.calibrationVersion ?? null,measurement.algorithmConfidence ?? null,
         measurement.qualityScore ?? null,measurement.qualityFlags,measurement.continuityToken ?? null,
         measurement.manualCutBefore ?? false,JSON.stringify(measurement.attributes),sha256(canonicalJson(measurement))]
      );
      if (measurement.resultKind === "POSITION") await this.insertPosition(client,measurementId,measurement);
      ids.set(measurement.measurementKey,measurementId);
    }
    return ids;
  }

  private async insertPosition(client: pg.PoolClient,measurementId: string,measurement: CanonicalMeasurementInput): Promise<void> {
    const source = measurement.sourceGeometry;
    if (!source) throw new Error("POSITION is missing sourceGeometry after validation");
    const uncertainty = measurement.uncertainty ?? { model: "UNKNOWN" as const };
    const covariance = uncertainty.covariance;
    const position = measurement.position;
    await client.query(
      `INSERT INTO position_measurement(
         measurement_id,analysis_space_key,source_position,position,altitude_m,vertical_datum,
         cov_xx_m2,cov_xy_m2,cov_yy_m2,horizontal_stddev_m,accuracy_radius_m,
         accuracy_model,accuracy_confidence
       ) VALUES (
         $1,$2,ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($3::jsonb)),4326),
         CASE WHEN $4::double precision IS NULL
              THEN ST_Transform(ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($3::jsonb)),4326),$6::integer)
              ELSE ST_SetSRID(ST_MakePoint($4,$5),$6::integer) END,
         $7,$8,$9,$10,$11,$12,$13,$14,$15
       )`,
      [measurementId,measurement.analysisSpaceKey ?? this.config.analysisSpaceKey,JSON.stringify(source),
       position?.x ?? null,position?.y ?? null,position?.srid ?? this.config.analysisSrid,
       measurement.altitudeM ?? null,measurement.verticalDatum ?? null,
       covariance?.[0][0] ?? null,covariance?.[0][1] ?? null,covariance?.[1][1] ?? null,
       uncertainty.model === "STDDEV" ? uncertainty.horizontalValue ?? null : null,
       uncertainty.model === "HARD_RADIUS" ? uncertainty.horizontalValue ?? null : null,
       uncertainty.model,uncertainty.confidenceLevel ?? null]
    );
  }

  private async insertAssertions(
    client: pg.PoolClient,bundle: CanonicalObservationBundle,timeSolutionId: string,
    processingRunId: string,measurementIds: Map<string,string>
  ): Promise<void> {
    for (const assertion of bundle.assertions) {
      const inputs = assertion.inputMeasurementKeys.map((key) => {
        const id = measurementIds.get(key);
        if (!id) throw Object.assign(new Error(`assertion references unknown measurementKey ${key}`), { statusCode: 422 });
        return id;
      });
      await client.query(
        `INSERT INTO observation_assertion(
           observation_id,time_solution_id,processing_run_id,assertion_kind,label,probability,
           calibration_version,basis_reference,input_measurement_ids
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid[])`,
        [bundle.envelope.observationId,timeSolutionId,processingRunId,assertion.assertionKind,
         assertion.label,assertion.probability ?? null,assertion.calibrationVersion ?? null,
         assertion.basisReference,inputs]
      );
    }
  }

  async get(observationId: string): Promise<ObservationEnvelope | undefined> {
    const result = await this.pool.query(`${OBSERVATION_SELECT} WHERE observation_id=$1`,[observationId]);
    const row = result.rows[0] as Record<string,unknown> | undefined;
    return row ? mapObservation(row) : undefined;
  }

  async getCanonicalEvidence(observationId: string): Promise<Record<string,unknown> | undefined> {
    const eventResult = await this.pool.query(
      `${OBSERVATION_SELECT} WHERE observation_id=$1`,[observationId]
    );
    const event = eventResult.rows[0] as Record<string,unknown> | undefined;
    if (!event) return undefined;
    const [timeResult,measurementResult,assertionResult] = await Promise.all([
      this.pool.query(
        `SELECT ts.*,lower(ts.phenomenon_time_window) AS window_start,
                upper(ts.phenomenon_time_window) AS window_end,
                extract(epoch FROM ts.exposure_or_scan_duration)*1000 AS exposure_ms,
                c.model_version AS clock_model_version,c.clock_domain,c.offset_seconds,c.drift_ppm,
                p.processor_name,p.processor_version,p.config_hash,p.code_digest
         FROM observation_time_solution ts
         JOIN source_clock_model c ON c.clock_model_id=ts.clock_model_id
         JOIN processing_run p ON p.processing_run_id=ts.processing_run_id
         WHERE ts.observation_id=$1 ORDER BY ts.created_at,ts.time_solution_id`,[observationId]
      ),
      this.pool.query(
        `SELECT m.*,CASE WHEN m.source_geometry IS NULL THEN NULL ELSE ST_AsGeoJSON(m.source_geometry)::jsonb END AS source_geometry_json,
                pm.analysis_space_key,CASE WHEN pm.position IS NULL THEN NULL ELSE ST_X(pm.position) END AS x,
                CASE WHEN pm.position IS NULL THEN NULL ELSE ST_Y(pm.position) END AS y,
                CASE WHEN pm.position IS NULL THEN NULL ELSE ST_SRID(pm.position) END AS position_srid,
                pm.altitude_m,pm.vertical_datum,pm.cov_xx_m2,pm.cov_xy_m2,pm.cov_yy_m2,
                pm.horizontal_stddev_m,pm.accuracy_radius_m,pm.accuracy_model,pm.accuracy_confidence
         FROM measurement m LEFT JOIN position_measurement pm ON pm.measurement_id=m.measurement_id
         WHERE m.observation_id=$1 ORDER BY m.created_at,m.measurement_id`,[observationId]
      ),
      this.pool.query(
        `SELECT * FROM observation_assertion WHERE observation_id=$1 ORDER BY created_at,assertion_id`,
        [observationId]
      )
    ]);
    const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value ? new Date(String(value)).toISOString() : null;
    return {
      canonicalEvidenceContractVersion: "1.2",
      event: {
        ...mapObservation(event),
        dataScopeKey: event.data_scope_key,
        sourceRecordKey: event.source_record_key,
        sourceRevisionNo: Number(event.source_revision_no),
        supersedesObservationId: event.supersedes_observation_id,
        originKind: event.origin_kind,
        sourceLocalTargetId: event.source_local_target_id,
        trackerSessionId: event.tracker_session_id,
        datastreamKey: event.datastream_key,
        producerPipelineKey: event.producer_pipeline_key,
        rawReference: event.raw_reference,
        payloadHash: event.payload_hash,
        qualityFlags: event.quality_flags,
        entityBindingStatus: event.entity_binding_status,
        timeSemantics: {
          sourceTime: iso(event.source_time_value),sourceTimeRaw: event.source_time_raw,
          sourceTimeTicks: event.source_time_ticks,resultTime: iso(event.result_time),
          sourceEmittedTime: iso(event.source_emitted_time),
          upstreamReceivedTime: iso(event.upstream_received_time),
          sourceProcessedTime: iso(event.source_processed_time),receivedTime: iso(event.received_at),
          ingestedTime: iso(event.processing_time)
        }
      },
      timeSolutions: timeResult.rows.map((row) => ({
        timeSolutionId: row.time_solution_id,clockModelId: row.clock_model_id,
        processingRunId: row.processing_run_id,supersedesTimeSolutionId: row.supersedes_time_solution_id,
        phenomenonTimeEstimate: iso(row.phenomenon_time_estimate),
        phenomenonTimeWindow: { start: iso(row.window_start),end: iso(row.window_end),bounds: "[)" },
        uncertaintySeconds: Number(row.uncertainty_seconds),solutionMethod: row.solution_method,
        exposureOrScanDurationMs: row.exposure_ms === null ? null : Number(row.exposure_ms),
        clockModel: { version: row.clock_model_version,domain: row.clock_domain,
          offsetSeconds: Number(row.offset_seconds),driftPpm: row.drift_ppm === null ? null : Number(row.drift_ppm) },
        processing: { name: row.processor_name,version: row.processor_version,
          configHash: row.config_hash,codeDigest: row.code_digest }
      })),
      measurements: measurementResult.rows.map((row) => ({
        measurementId: row.measurement_id,timeSolutionId: row.time_solution_id,
        processingRunId: row.processing_run_id,measurementKey: row.measurement_key,
        measurementStage: row.measurement_stage,observedProperty: row.observed_property,
        resultKind: row.result_kind,scalarValue: row.scalar_value,valueUnit: row.value_unit,
        vectorValue: row.vector_value,sourceGeometry: row.source_geometry_json,nativeFrame: row.native_frame,
        measurementModel: row.measurement_model,measurementModelVersion: row.measurement_model_version,
        calibrationVersion: row.calibration_version,algorithmConfidence: row.algorithm_confidence,
        qualityScore: row.quality_score,qualityFlags: row.quality_flags,
        continuityToken: row.continuity_token,manualCutBefore: row.manual_cut_before,attributes: row.attributes,
        ...(row.analysis_space_key ? {
          position: { analysisSpaceKey: row.analysis_space_key,x: Number(row.x),y: Number(row.y),srid: Number(row.position_srid),
            altitudeM: row.altitude_m,verticalDatum: row.vertical_datum },
          uncertainty: uncertaintyFromRow(row as Record<string,unknown>)
        } : {})
      })),
      assertions: assertionResult.rows.map((row) => ({
        assertionId: row.assertion_id,timeSolutionId: row.time_solution_id,
        processingRunId: row.processing_run_id,assertionKind: row.assertion_kind,label: row.label,
        probability: row.probability,calibrationVersion: row.calibration_version,
        basisReference: row.basis_reference,inputMeasurementIds: row.input_measurement_ids
      }))
    };
  }

  async query(options: {
    subjectId?: string; observerId?: string; observationType?: string; from?: string; to?: string; limit?: number;
  }): Promise<ObservationEnvelope[]> {
    const conditions = ["true"];
    const params: unknown[] = [];
    const add = (sql: string,value: unknown) => {
      params.push(value);
      conditions.push(sql.replace("?",`$${params.length}`));
    };
    if (options.subjectId) add("subject_id=?",options.subjectId);
    if (options.observerId) add("observer_id=?",options.observerId);
    if (options.observationType) add("observation_type=?",options.observationType);
    if (options.from) add("observed_at>=?",options.from);
    if (options.to) add("observed_at<=?",options.to);
    params.push(options.limit ?? 1_000);
    const result = await this.pool.query(
      `${OBSERVATION_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY observed_at DESC,observation_id LIMIT $${params.length}`,
      params
    );
    return result.rows.map((row) => mapObservation(row as Record<string,unknown>));
  }

  async claimBatch(workerName: string,batchSize: number): Promise<string[]> {
    const result = await this.pool.query<{ observation_id: string }>(
      "SELECT observation_id FROM claim_projection_batch($1,$2)",[workerName,batchSize]
    );
    return result.rows.map((row) => row.observation_id);
  }

  async markFailure(observationId: string,error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.pool.query(
      `UPDATE projection_queue SET locked_at=NULL,locked_by=NULL,last_error=$2,
         available_at=clock_timestamp()+LEAST(interval '5 minutes',make_interval(secs=>power(2,LEAST(attempts,8))::integer))
       WHERE observation_id=$1`,
      [observationId,message.slice(0,4_000)]
    );
  }
}

function externalCorrelationFields(bundle: CanonicalObservationBundle) {
  return {
    ...(bundle.executionIntentId === undefined ? {} : { executionIntentId: bundle.executionIntentId }),
    ...(bundle.operationCorrelationId === undefined ? {} : { operationCorrelationId: bundle.operationCorrelationId }),
    ...(bundle.externalPlanningTaskId === undefined ? {} : { externalPlanningTaskId: bundle.externalPlanningTaskId }),
    ...(bundle.externalPlanningStepId === undefined ? {} : { externalPlanningStepId: bundle.externalPlanningStepId }),
    ...(bundle.providerActionId === undefined ? {} : { providerActionId: bundle.providerActionId }),
    ...(bundle.deviceCommandId === undefined ? {} : { deviceCommandId: bundle.deviceCommandId })
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uncertaintyFromRow(row: Record<string,unknown>): Record<string,unknown> {
  const model = String(row.accuracy_model);
  if (model === "HARD_RADIUS") return { model,unit: "m",horizontalValue: Number(row.accuracy_radius_m),confidenceLevel: row.accuracy_confidence };
  if (model === "STDDEV") return { model,unit: "m",horizontalValue: Number(row.horizontal_stddev_m),confidenceLevel: row.accuracy_confidence };
  if (model === "COVARIANCE") return { model,unit: "m2",covariance: [
    [Number(row.cov_xx_m2),Number(row.cov_xy_m2)],
    [Number(row.cov_xy_m2),Number(row.cov_yy_m2)]
  ],confidenceLevel: row.accuracy_confidence };
  return { model };
}
