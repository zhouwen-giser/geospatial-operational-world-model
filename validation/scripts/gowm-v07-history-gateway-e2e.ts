import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import type {
  CapabilityDescriptor,
  CapabilityProviderManifest,
  DataSnapshotContext,
  GowmV07HistoricalTrajectoryQuery,
  GowmV07HistoricalTrajectoryResult,
  GowmV07QuerySnapshotManifest,
  GowmV07TaskExecutionIntervalQuery,
  GowmV07TaskExecutionIntervalResult,
  WorldQueryPlanV2SchemaPort,
  WorldQuerySubmission
} from "../../packages/platform/contract-runtime/src/index.js";
import { getContractSchemaHash } from "../../packages/platform/contract-runtime/src/index.js";
import {
  HistoricalProjectionCoordinator,
  PostgresHistoricalTrajectoryMaterializer,
  PostgresTaskIntervalProjectionRepository,
  PostgresTrackletProjectionRepository
} from "../../packages/historical-trace-runtime/src/index.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { OperationalEventRepository } from "../../packages/runtime/src/operational-event-repository.js";
import { OperationalProjectionRepository } from "../../packages/runtime/src/operational-projection-repository.js";
import {
  buildGatewayApp,
  CapabilityRegistry,
  DirectExecutionService,
  HttpProviderClient,
  MemoryAuditSink,
  PostgresGatewayIdempotencyStore,
  PostgresGatewayRecordStore,
  PostgresQueryPlanStore,
  ProviderCircuitBreaker,
  QueryPlanValidator,
  synchronizePostgresRegistry,
  WorldQueryRuntime,
  type GatewayPrincipal
} from "../../services/gateway/world-capability-gateway/src/index.js";
import { buildHistoricalTraceApp } from "../../services/providers/historical-trace-provider/src/app.js";
import { createHistoricalTraceProvider } from "../../services/providers/historical-trace-provider/src/provider.js";
import { buildOperationalRealityApp } from "../../services/providers/operational-reality-provider/src/app.js";
import { createOperationalRealityProvider } from "../../services/providers/operational-reality-provider/src/provider.js";
import {
  withMigratedV07Database,
  type V07DatabaseEvidence
} from "./gowm-v07-postgres-harness.js";

type JsonRecord = Record<string, unknown>;
type FastifyApp = ReturnType<typeof buildGatewayApp>;

interface FixtureIdentity {
  scopeA: string;
  scopeB: string;
  sourceKey: string;
  pipelineKey: string;
  datastreamKey: string;
  trackerSessionKey: string;
  targetKey: string;
  operationalTaskId: string;
  subjectReferenceKey: string;
  processingRunId: string;
  clockModelId: string;
}

interface TrackletPin {
  trackletVersionId: string;
  versionNo: number;
  contentHash: `sha256:${string}`;
  createdAt: string;
  finalizationRevisionId: string;
  finalizationRevisionNo: number;
  finalizationContentHash: `sha256:${string}`;
  finalizationState: "PROVISIONAL" | "SEALED" | "REOPENED" | "CONFLICTED";
  finalizationCreatedAt: string;
}

interface TrajectoryPin {
  historicalTrajectoryId: string;
  referenceKey: string;
  revisionNo: number;
  revisionId: string;
  analysisId: string;
  contentHash: `sha256:${string}`;
  inputSetHash: `sha256:${string}`;
  intervalRevisionId: string;
  supersedesRevisionId?: string;
  createdAt: string;
}

type IntervalReferenceKey = GowmV07TaskExecutionIntervalResult["intervals"][number]["executionIntervalReferenceKey"];

interface IntervalPin {
  referenceKey: IntervalReferenceKey;
  revisionId: string;
  contentHash: `sha256:${string}`;
}

interface GatewayProviderRegistration {
  approvalId: string;
  manifest: CapabilityProviderManifest;
  endpoint: URL;
  client: HttpProviderClient;
}

interface GatewayResponse {
  status: number;
  replayed: boolean;
  body: JsonRecord;
}

await withMigratedV07Database("history_gateway", async (databaseUrl, versions, runId) => {
  await runGatewayHistoricalE2e(databaseUrl, versions, runId);
});

async function runGatewayHistoricalE2e(
  databaseUrl: string,
  versions: V07DatabaseEvidence,
  runId: string
): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
  const fixture = fixtureIdentity(runId);
  const transportToken = `HistoryGatewayTransport_${runId}_ValidationOnly`;
  let providerApp: ReturnType<typeof buildHistoricalTraceApp> | undefined;
  let operationalProviderApp: ReturnType<typeof buildOperationalRealityApp> | undefined;
  let gatewayApp: FastifyApp | undefined;
  let providerHttpExecuteCalls = 0;
  let operationalProviderHttpExecuteCalls = 0;
  let gatewayHttpSubmissions = 0;
  const historyProviderIntervalReferenceKeyHashes: string[] = [];

  try {
    await seedFixtureFoundation(pool, fixture);
    await seedTaskEvents(pool, fixture);
    await seedInitialPositions(pool, fixture);
    await seedCompleteWatermark(pool, fixture);
    await projectOperationalAndHistory(pool, fixture, `initial-${runId}`);

    const provider = createHistoricalTraceProvider({ pool });
    const manifest = provider.runtime.manifest;
    providerApp = buildHistoricalTraceApp(provider, transportToken);
    providerApp.addHook("onError", async (_request, _reply, error) => {
      emitDiagnosticError("historical-provider", error);
    });
    providerApp.addHook("onRequest", async (request) => {
      if (request.method === "POST" && request.url.includes("/v1/operations/history.get-trajectory:execute")) {
        providerHttpExecuteCalls += 1;
      }
    });
    providerApp.addHook("preHandler", async (request) => {
      if (request.method !== "POST" || !request.url.includes("/v1/operations/history.get-trajectory:execute")) return;
      const body = requiredRecord(request.body, "historical Provider request");
      const input = requiredRecord(body.input, "historical Provider input");
      historyProviderIntervalReferenceKeyHashes.push(sha256(
        requiredRecord(input.executionIntervalReferenceKey, "historical Provider interval ReferenceKey")
      ));
    });
    await providerApp.listen({ host: "127.0.0.1", port: 0 });
    const providerEndpoint = listenerUrl(providerApp);
    const providerClient = new HttpProviderClient({
      endpoint: providerEndpoint,
      providerId: manifest.provider.providerId,
      providerVersion: manifest.provider.providerVersion,
      implementationDigest: manifest.provider.implementationDigest as `sha256:${string}`,
      manifestHash: sha256(manifest),
      approvedManifest: manifest,
      transportToken,
      allowPlaintextPrivateNetwork: false
    });

    const operationalProvider = createOperationalRealityProvider({ pool });
    const operationalManifest = operationalProvider.runtime.manifest;
    operationalProviderApp = buildOperationalRealityApp(operationalProvider, transportToken);
    operationalProviderApp.addHook("onError", async (_request, _reply, error) => {
      emitDiagnosticError("operational-provider", error);
    });
    operationalProviderApp.addHook("onRequest", async (request) => {
      if (request.method === "POST"
        && request.url.includes("/v1/operations/operational-task.get-execution-intervals:execute")) {
        operationalProviderHttpExecuteCalls += 1;
      }
    });
    await operationalProviderApp.listen({ host: "127.0.0.1", port: 0 });
    const operationalProviderEndpoint = listenerUrl(operationalProviderApp);
    const operationalProviderClient = new HttpProviderClient({
      endpoint: operationalProviderEndpoint,
      providerId: operationalManifest.provider.providerId,
      providerVersion: operationalManifest.provider.providerVersion,
      implementationDigest: operationalManifest.provider.implementationDigest as `sha256:${string}`,
      manifestHash: sha256(operationalManifest),
      approvedManifest: operationalManifest,
      transportToken,
      allowPlaintextPrivateNetwork: false
    });
    const providerRegistrations: GatewayProviderRegistration[] = [{
      approvalId: `history-gateway-e2e-${runId}`,
      manifest,
      endpoint: providerEndpoint,
      client: providerClient
    }, {
      approvalId: `history-interval-gateway-e2e-${runId}`,
      manifest: operationalManifest,
      endpoint: operationalProviderEndpoint,
      client: operationalProviderClient
    }];
    await synchronizePostgresRegistry(pool, providerRegistrations.map((registration) => ({
      config: {
        providerId: registration.manifest.provider.providerId,
        providerVersion: registration.manifest.provider.providerVersion,
        implementationDigest: registration.manifest.provider.implementationDigest as `sha256:${string}`,
        manifestHash: sha256(registration.manifest),
        manifestPath: `inline://${registration.manifest.provider.providerId}`,
        endpoint: registration.endpoint,
        approvalId: registration.approvalId,
        approvedBy: "gowm-v07-history-gateway-e2e",
        transportTokenEnv: "GOWM_V07_E2E_PROVIDER_TOKEN",
        allowPlaintextPrivateNetwork: false,
        approvedManifest: registration.manifest
      },
      manifest: registration.manifest
    })));
    const gateway = gatewayRuntime(pool, providerRegistrations, fixture, runId);
    gatewayApp = gateway.app;
    gatewayApp.addHook("onError", async (_request, _reply, error) => {
      emitDiagnosticError("gateway", error);
    });
    await gatewayApp.listen({ host: "127.0.0.1", port: 0 });
    const gatewayBase = listenerUrl(gatewayApp).toString().replace(/\/$/u, "");
    const validationClientTargets: string[] = [];
    const submit = async (
      submission: WorldQuerySubmission,
      dataScopeKey: string,
      asynchronous = false
    ): Promise<GatewayResponse> => {
      validationClientTargets.push(`${gatewayBase}/v1/world-queries`);
      return submitGateway(gatewayBase, submission, dataScopeKey, asynchronous);
    };

    const intervalDescriptor = requiredDescriptor(
      operationalManifest,
      "operational-task.get-execution-intervals"
    );
    const historyDescriptor = requiredDescriptor(manifest, "history.get-trajectory");
    const taskReferenceKey = await loadOperationalTaskReferenceKey(pool, fixture);
    const intervalQuery: GowmV07TaskExecutionIntervalQuery = {
      taskReferenceKey,
      selection: { kind: "EXECUTION_NO", executionNo: 1 },
      phaseScope: "EXECUTION_ENVELOPE"
    };
    const intervalPin = await loadCurrentIntervalPin(pool, fixture);
    const query = historicalQuery(fixture, intervalPin.referenceKey);
    const trackletV1 = await loadCurrentTrackletPin(pool, fixture);
    assert.equal(trackletV1.versionNo, 1, "initial Tracklet version must be v1");
    assert.equal(trackletV1.finalizationState, "SEALED", "initial Tracklet must be sealed by the complete watermark");
    const materializer = new PostgresHistoricalTrajectoryMaterializer(pool);
    const h1CapturedAt = await databaseNow(pool);
    const h1Materialized = await materializer.materialize({
      dataScopeKey: fixture.scopeA,
      capturedAt: h1CapturedAt,
      query
    });
    assert.equal(h1Materialized.status, "MATERIALIZED", JSON.stringify(h1Materialized));
    if (h1Materialized.status !== "MATERIALIZED") throw new Error("h1 materialization did not produce a trajectory");
    assert.equal(h1Materialized.reused, false, "initial runtime materialization must create h1");
    const h1 = await loadTrajectoryPin(pool, h1Materialized.trajectoryRevisionId);
    assert.equal(h1.revisionNo, 1, "initial Historical Trajectory must be h1");
    assert.equal(h1.contentHash, h1Materialized.contentHash);
    assert.equal(h1.supersedesRevisionId, undefined, "h1 must be the lineage root");
    assert.equal(h1.intervalRevisionId, intervalPin.revisionId, "trajectory lineage must retain the interval revision UUID");
    const h1LineagePinned = await assertTrajectoryTrackletLineage(pool, h1, trackletV1);

    const q1Submission = intervalTrajectorySubmission(
      `q1-${runId}`,
      intervalDescriptor,
      intervalQuery,
      historyDescriptor,
      query
    );
    assert.equal(q1Submission.plan.nodes.length, 2, "Q1 must be one two-Provider World Query DAG");
    const historyIntervalBinding = q1Submission.plan.nodes[1]?.inputs.executionIntervalReferenceKey;
    assert(historyIntervalBinding?.kind === "NODE_OUTPUT", "history input must be bound to interval node output");
    assert.equal(historyIntervalBinding.nodeId, "executionIntervals");
    assert.equal(historyIntervalBinding.outputPort, "executionIntervalReferenceKey");
    assert.equal(historyIntervalBinding.path, "/intervals/0/executionIntervalReferenceKey");
    assert.equal(historyIntervalBinding.targetPath, "/executionIntervalReferenceKey");
    const q1 = await submit(q1Submission, fixture.scopeA);
    gatewayHttpSubmissions += 1;
    assert.equal(q1.status, 200, JSON.stringify(q1.body));
    const intervalResult = intervalOutput(q1);
    assert.equal(intervalResult.status, "COMPLETED", JSON.stringify(intervalResult));
    assert.equal(intervalResult.reasonCode, "INTERVALS_AVAILABLE");
    assert.equal(intervalResult.intervals.length, 1, "Gateway interval discovery must resolve one execution");
    const intervalReferenceKey = structuredClone(intervalResult.intervals[0]!.executionIntervalReferenceKey);
    const intervalReferenceKeyHash = sha256(intervalReferenceKey);
    assert.deepEqual(
      intervalReferenceKey,
      intervalPin.referenceKey,
      "Gateway interval output must expose the canonical public interval ReferenceKey"
    );
    const q1Trajectory = trajectoryOutput(q1);
    assert.deepEqual(q1Trajectory.executionIntervalReferenceKey, intervalReferenceKey);
    assert.equal(sha256(q1Trajectory.executionIntervalReferenceKey), intervalReferenceKeyHash);
    assert.equal(
      historyProviderIntervalReferenceKeyHashes[0],
      intervalReferenceKeyHash,
      "Historical Provider must receive the exact interval ReferenceKey produced by the upstream node"
    );
    assert.equal(operationalProviderHttpExecuteCalls, 1, "Q1 DAG must call interval Provider once");
    assert.equal(providerHttpExecuteCalls, 1, "Q1 DAG must call historical Provider once");
    const q1SingleSubmissionTwoProviderDag = historyProviderIntervalReferenceKeyHashes[0] === intervalReferenceKeyHash
      && historyIntervalBinding.kind === "NODE_OUTPUT"
      && operationalProviderHttpExecuteCalls === 1
      && providerHttpExecuteCalls === 1;
    assert(q1SingleSubmissionTwoProviderDag);
    assert.equal(q1Trajectory.trajectoryReferenceKey?.id, h1.referenceKey);
    assert.equal(q1Trajectory.trajectoryReferenceKey?.version, "1");
    const q1ValueHash = sha256(q1Trajectory);
    const q1WorldOutputHash = requiredString(q1.body.outputHash, "Q1 outputHash");
    const q1Snapshot = snapshotManifest(q1);
    const q1OperationalProviderSnapshot = nodeProviderSnapshot(q1, "executionIntervals");
    const q1HistoricalProviderSnapshot = nodeProviderSnapshot(q1, "historicalTrajectory");
    const q1OperationalSnapshotMerged = assertProviderSnapshotMerged(q1OperationalProviderSnapshot, q1Snapshot);
    const q1HistoricalSnapshotMerged = assertProviderSnapshotMerged(q1HistoricalProviderSnapshot, q1Snapshot);
    assert(q1OperationalProviderSnapshot.resources.some((resource) =>
      resource.referenceKey.kind === "TASK_EXECUTION_EVENT_SET"
    ), "operational Provider snapshot must contribute its event-set pin");
    assert(q1HistoricalProviderSnapshot.resources.some((resource) =>
      resource.referenceKey.kind === "HISTORICAL_TRAJECTORY"
    ), "historical Provider snapshot must contribute its trajectory pin");
    const envelopeIncludesPausedMovement = q1Trajectory.preview.some((point) => {
      const timestamp = Date.parse(point.observedAt);
      return timestamp >= Date.parse("2026-08-30T00:00:04.000Z")
        && timestamp < Date.parse("2026-08-30T00:00:06.000Z");
    });
    assert(envelopeIncludesPausedMovement, "EXECUTION_ENVELOPE must retain movement observed while the task was paused");
    const q1TrajectoryPinVerified = assertSnapshotPin(
      q1Snapshot, "HISTORICAL_TRAJECTORY", `gowm:${h1.referenceKey}`, "1", h1.contentHash
    );
    const q1TrackletPinVerified = assertSnapshotPin(
      q1Snapshot, "TRACKLET_VERSION", `gowm.mobility:${trackletV1.trackletVersionId}`, "1", trackletV1.contentHash
    );
    const q1IntervalPinVerified = assertSnapshotPin(
      q1Snapshot,
      "TASK_EXECUTION_INTERVAL",
      `gowm:${intervalReferenceKey.id}`,
      intervalReferenceKey.version,
      intervalPin.contentHash
    );
    const intervalProviderSnapshotPinVerified = q1OperationalSnapshotMerged && q1IntervalPinVerified;
    const q1CompleteLineagePinned = await assertTrajectoryCompleteLineage(pool, h1, q1Snapshot);

    const providerCallsAfterQ1 = providerHttpExecuteCalls;
    const q1Replay = await submit(structuredClone(q1Submission), fixture.scopeA);
    gatewayHttpSubmissions += 1;
    assert.equal(q1Replay.status, 200, JSON.stringify(q1Replay.body));
    assert.equal(q1Replay.replayed, true, "Q1 replay must come from durable Gateway idempotency");
    assert.equal(requiredString(q1Replay.body.outputHash, "Q1 replay outputHash"), q1WorldOutputHash);
    assert.equal(sha256(trajectoryOutput(q1Replay)), q1ValueHash);
    assert.equal(providerHttpExecuteCalls, providerCallsAfterQ1, "Q1 replay must not re-call the Provider");
    assert.equal(operationalProviderHttpExecuteCalls, 1, "Q1 replay must not re-call the interval Provider");

    // Q4 is submitted first so the Gateway durably fixes capturedAt, then the
    // late observation advances Tracklet/Trajectory heads before execution.
    const q4Submission = oneNodeSubmission(`q4-${runId}`, manifest.capabilities[0]!, query, {
      mode: "LATEST_AT_START"
    });
    const q4Queued = await submit(q4Submission, fixture.scopeA, true);
    gatewayHttpSubmissions += 1;
    assert.equal(q4Queued.status, 202, JSON.stringify(q4Queued.body));
    const q4JobId = requiredString(q4Queued.body.jobId, "Q4 jobId");
    const queuedContext = await gateway.store.getByJobId(q4JobId);
    assert(queuedContext, "Q4 durable query context is missing");
    const q4CapturedAt = queuedContext.requestedSnapshotManifest.capturedAt;

    await waitForDatabaseClockAfter(pool, q4CapturedAt);
    await insertPosition(pool, fixture, {
      ordinal: 99,
      phenomenonTime: "2026-08-30T00:00:05.500Z",
      x: 448_005.5,
      y: 4_417_000,
      manualCutBefore: false
    });
    await projectOperationalAndHistory(pool, fixture, `late-${runId}`);
    const trackletV2 = await loadCurrentTrackletPin(pool, fixture);
    assert.equal(trackletV2.versionNo, 2, "late observation must create Tracklet v2");
    assert.equal(trackletV2.finalizationState, "SEALED", "late Tracklet must be sealed by the existing complete watermark");
    const lineage = await pool.query<{ late_data_count: number; lineage_count: number }>(
      `SELECT count(*) FILTER (WHERE lineage_type='LATE_DATA')::integer AS late_data_count,
              count(*)::integer AS lineage_count
       FROM public.mobility_tracklet_lineage
       WHERE parent_version_id=$1::uuid AND child_version_id=$2::uuid`,
      [trackletV1.trackletVersionId, trackletV2.trackletVersionId]
    );
    assert.equal(Number(lineage.rows[0]?.late_data_count), 1, "late observation lineage must be explicit");
    assert(Number(lineage.rows[0]?.lineage_count) >= 1, "Tracklet revision lineage must be non-empty");
    const h2Materialized = await materializer.materialize({
      dataScopeKey: fixture.scopeA,
      capturedAt: await databaseNow(pool),
      query
    });
    assert.equal(h2Materialized.status, "MATERIALIZED", JSON.stringify(h2Materialized));
    if (h2Materialized.status !== "MATERIALIZED") throw new Error("late-data materialization did not produce h2");
    assert.equal(h2Materialized.reused, false, "late-data runtime materialization must create h2");
    const h2 = await loadTrajectoryPin(pool, h2Materialized.trajectoryRevisionId);
    assert.equal(h2.revisionNo, 2, "late data must create h2");
    assert.notEqual(h2.contentHash, h1.contentHash, "h2 content hash must differ from h1");
    assert.notEqual(h2.inputSetHash, h1.inputSetHash, "h2 input lineage digest must differ from h1");
    assert.equal(h2.historicalTrajectoryId, h1.historicalTrajectoryId, "h1 and h2 must share one immutable identity");
    assert.equal(h2.supersedesRevisionId, h1.revisionId, "h2 must explicitly supersede h1");
    assert.equal(h2.intervalRevisionId, h1.intervalRevisionId, "late position must not float the task interval pin");
    const h2LineagePinned = await assertTrajectoryTrackletLineage(pool, h2, trackletV2);
    const trajectoryHead = await pool.query<{ current_revision_id: string }>(
      `SELECT current_revision_id FROM gowm_history.historical_trajectory_head
       WHERE historical_trajectory_id=$1::uuid`,
      [h1.historicalTrajectoryId]
    );
    assert.equal(trajectoryHead.rows[0]?.current_revision_id, h2.revisionId, "h2 must be the new trajectory head");
    assert(Date.parse(h2.createdAt) > Date.parse(q4CapturedAt), "h2 must be created after Q4 capturedAt");
    const activeQuery: GowmV07HistoricalTrajectoryQuery = {
      ...query,
      phaseScope: "ACTIVE_PHASES_ONLY"
    };
    const activeMaterialized = await materializer.materialize({
      dataScopeKey: fixture.scopeA,
      capturedAt: await databaseNow(pool),
      query: activeQuery
    });
    assert.equal(activeMaterialized.status, "MATERIALIZED", JSON.stringify(activeMaterialized));
    if (activeMaterialized.status !== "MATERIALIZED") throw new Error("ACTIVE materialization did not produce a trajectory");
    assert.equal(activeMaterialized.reused, false, "first ACTIVE runtime materialization must create its h1");
    const activeH1 = await loadTrajectoryPin(pool, activeMaterialized.trajectoryRevisionId);
    assert.equal(activeH1.revisionNo, 1);
    assert.equal(activeH1.supersedesRevisionId, undefined);
    assert.notEqual(activeH1.historicalTrajectoryId, h2.historicalTrajectoryId, "phase scope must be part of trajectory identity");
    assert.equal(activeH1.intervalRevisionId, h2.intervalRevisionId);
    const activeLineagePinned = await assertTrajectoryTrackletLineage(pool, activeH1, trackletV2);
    const unknownActiveGap = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM public.mobility_tracklet_gap
       WHERE tracklet_version_id=$1::uuid AND observability_state='UNKNOWN'
         AND lower(gap_time)='2026-08-30T00:00:02.000Z'::timestamptz
         AND upper(gap_time)='2026-08-30T00:00:03.000Z'::timestamptz`,
      [trackletV2.trackletVersionId]
    );
    assert.equal(Number(unknownActiveGap.rows[0]?.count), 1, "fixture must contain one unknown gap inside active time");

    const q4Run = await gateway.runtime.run(q4JobId);
    assert.equal(q4Run.status, "PARTIAL", "gap-preserving Q4 result remains PARTIAL");
    const q4ReadTarget = `${gatewayBase}/v1/jobs/${encodeURIComponent(q4JobId)}`;
    validationClientTargets.push(q4ReadTarget);
    const q4Read = await fetch(q4ReadTarget, {
      headers: { "x-validation-scope": fixture.scopeA }
    });
    assert.equal(q4Read.status, 200);
    const q4Job = await q4Read.json() as JsonRecord;
    const q4Result = requiredRecord(q4Job.result, "Q4 job result");
    const q4Response: GatewayResponse = { status: 200, replayed: false, body: q4Result };
    const q4Trajectory = trajectoryOutput(q4Response);
    assert.equal(q4Trajectory.trajectoryReferenceKey?.id, h1.referenceKey);
    assert.equal(q4Trajectory.trajectoryReferenceKey?.version, "1", "fixed capturedAt must not float to h2");
    assert.equal(sha256(q4Trajectory), q1ValueHash);
    const q4Snapshot = snapshotManifest(q4Response);
    assert.equal(q4Snapshot.capturedAt, q4CapturedAt, "queued query must execute with its durably captured snapshot time");
    const q4TrajectoryPinVerified = assertSnapshotPin(
      q4Snapshot, "HISTORICAL_TRAJECTORY", `gowm:${h1.referenceKey}`, "1", h1.contentHash
    );
    const q4CompleteLineagePinned = await assertTrajectoryCompleteLineage(pool, h1, q4Snapshot);

    const q2Submission = oneNodeSubmission(`q2-${runId}`, manifest.capabilities[0]!, query, {
      mode: "LATEST_AT_START"
    });
    const q2 = await submit(q2Submission, fixture.scopeA);
    gatewayHttpSubmissions += 1;
    assert.equal(q2.status, 200, JSON.stringify(q2.body));
    const q2Trajectory = trajectoryOutput(q2);
    assert.deepEqual(q2Trajectory.executionIntervalReferenceKey, intervalReferenceKey);
    assert.equal(sha256(q2Trajectory.executionIntervalReferenceKey), intervalReferenceKeyHash);
    assert.equal(q2Trajectory.trajectoryReferenceKey?.id, h2.referenceKey);
    assert.equal(q2Trajectory.trajectoryReferenceKey?.version, "2");
    const q2ValueHash = sha256(q2Trajectory);
    assert.notEqual(q2ValueHash, q1ValueHash, "Q2 latest output must differ from Q1");
    const q2Snapshot = snapshotManifest(q2);
    const q2TrajectoryPinVerified = assertSnapshotPin(
      q2Snapshot, "HISTORICAL_TRAJECTORY", `gowm:${h2.referenceKey}`, "2", h2.contentHash
    );
    const q2TrackletPinVerified = assertSnapshotPin(
      q2Snapshot, "TRACKLET_VERSION", `gowm.mobility:${trackletV2.trackletVersionId}`, "2", trackletV2.contentHash
    );
    const q2CompleteLineagePinned = await assertTrajectoryCompleteLineage(pool, h2, q2Snapshot);

    const active = await submit(
      oneNodeSubmission(`active-${runId}`, manifest.capabilities[0]!, activeQuery, {
        mode: "LATEST_AT_START"
      }),
      fixture.scopeA
    );
    gatewayHttpSubmissions += 1;
    assert.equal(active.status, 200, JSON.stringify(active.body));
    const activeTrajectory = trajectoryOutput(active);
    assert.deepEqual(activeTrajectory.executionIntervalReferenceKey, intervalReferenceKey);
    assert.equal(activeTrajectory.status, "PARTIAL", "the active-only source gap must remain fail-visible");
    assert.equal(activeTrajectory.trajectoryReferenceKey?.id, activeH1.referenceKey);
    assert.equal(activeTrajectory.trajectoryReferenceKey?.version, "1");
    const pauseExcluded = activeTrajectory.excludedPeriods.some((item) =>
      item.reason === "EXCLUDED_PAUSED_PHASE"
      && item.range.start === "2026-08-30T00:00:04.000Z"
      && item.range.end === "2026-08-30T00:00:06.000Z"
    );
    assert(pauseExcluded, "ACTIVE query must expose the paused interval as an exclusion");
    const activeGapPreserved = activeTrajectory.gaps.some((gap) =>
      gap.reason === "TRACKLET_BOUNDARY_GAP"
      && gap.range.start === "2026-08-30T00:00:02.000Z"
      && gap.range.end === "2026-08-30T00:00:03.000Z"
    );
    assert(activeGapPreserved, "ACTIVE query must retain the unknown Tracklet gap intersecting active time");
    const activeRequestedPeriodsExact = [
      ["2026-08-30T00:00:00.000Z", "2026-08-30T00:00:04.000Z"],
      ["2026-08-30T00:00:06.000Z", "2026-08-30T00:00:10.000Z"]
    ].every(([start, end]) => activeTrajectory.requestedPeriods.some((period) =>
      period.start === start && period.end === end
    )) && activeTrajectory.requestedPeriods.length === 2;
    assert(activeRequestedPeriodsExact, "ACTIVE requested periods must be the two running phases");
    const activePreviewExcludesPausedTime = activeTrajectory.preview.every((point) => {
      const timestamp = Date.parse(point.observedAt);
      return timestamp < Date.parse("2026-08-30T00:00:04.000Z")
        || timestamp >= Date.parse("2026-08-30T00:00:06.000Z");
    });
    assert(activePreviewExcludesPausedTime, "ACTIVE preview must not contain samples from paused time");
    const activeSnapshot = snapshotManifest(active);
    const activeTrajectoryPinVerified = assertSnapshotPin(
      activeSnapshot, "HISTORICAL_TRAJECTORY", `gowm:${activeH1.referenceKey}`, "1", activeH1.contentHash
    );
    const activeTrackletPinVerified = assertSnapshotPin(
      activeSnapshot, "TRACKLET_VERSION", `gowm.mobility:${trackletV2.trackletVersionId}`, "2", trackletV2.contentHash
    );
    const activeCompleteLineagePinned = await assertTrajectoryCompleteLineage(pool, activeH1, activeSnapshot);

    const pinnedH1 = pinnedManifest(q1Snapshot, `pinned-h1-${runId}`);
    const q3Pinned = await submit(
      oneNodeSubmission(`q3-pinned-${runId}`, manifest.capabilities[0]!, query, {
        mode: "PINNED",
        pinnedSnapshot: pinnedH1
      }),
      fixture.scopeA
    );
    gatewayHttpSubmissions += 1;
    assert.equal(q3Pinned.status, 200, JSON.stringify(q3Pinned.body));
    const q3PinnedTrajectory = trajectoryOutput(q3Pinned);
    assert.equal(q3PinnedTrajectory.trajectoryReferenceKey?.version, "1");
    assert.equal(sha256(q3PinnedTrajectory), q1ValueHash, "pinned h1 output must be replayable byte-semantically");
    const q3PinnedTrajectoryPinVerified = assertSnapshotPin(
      snapshotManifest(q3Pinned), "HISTORICAL_TRAJECTORY", `gowm:${h1.referenceKey}`, "1", h1.contentHash
    );

    const q3CrossScope = await submit(
      oneNodeSubmission(`q3-cross-scope-${runId}`, manifest.capabilities[0]!, query, {
        mode: "LATEST_AT_START"
      }),
      fixture.scopeB
    );
    gatewayHttpSubmissions += 1;
    assert.equal(q3CrossScope.status, 200, JSON.stringify(q3CrossScope.body));
    const crossScopeOutput = trajectoryOutput(q3CrossScope);
    assert.equal(crossScopeOutput.status, "NO_DATA", "foreign-scope interval must fail closed as NO_DATA");
    assert.equal(crossScopeOutput.trajectoryReferenceKey, undefined);
    const crossScopeSerialized = JSON.stringify(q3CrossScope.body);
    const crossScopeNoForeignIdentityLeak = [
      h1.referenceKey, h1.contentHash, h2.contentHash,
      trackletV1.trackletVersionId, trackletV2.trackletVersionId
    ].every((foreignIdentity) => !crossScopeSerialized.includes(foreignIdentity));
    assert(crossScopeNoForeignIdentityLeak, "cross-scope result leaked a foreign resource identity");

    const oldRevision = await pool.query<{ content_hash: string }>(
      `SELECT content_hash FROM gowm_history.historical_trajectory_revision
       WHERE trajectory_revision_id=$1::uuid`,
      [h1.revisionId]
    );
    assert.equal(oldRevision.rows[0]?.content_hash, h1.contentHash, "h1 must remain immutable after late data");

    // The validation client only addresses the Gateway. Provider execute calls
    // are counted server-side and every one is attributable to a Gateway node.
    const providerOrigins = new Set([providerEndpoint.origin, operationalProviderEndpoint.origin]);
    const directProviderCallsFromValidationClient = validationClientTargets.filter(
      (target) => providerOrigins.has(new URL(target).origin)
    ).length;
    assert.equal(directProviderCallsFromValidationClient, 0);
    const validationClientGatewayOnly = validationClientTargets.every(
      (target) => new URL(target).origin === new URL(gatewayBase).origin
    );
    assert(validationClientGatewayOnly);
    const effectiveSnapshotPinsVerified = [
      intervalProviderSnapshotPinVerified,
      q1OperationalSnapshotMerged, q1HistoricalSnapshotMerged,
      q1TrajectoryPinVerified, q1TrackletPinVerified,
      q1IntervalPinVerified,
      q1CompleteLineagePinned,
      q4TrajectoryPinVerified, q4CompleteLineagePinned,
      q2TrajectoryPinVerified, q2TrackletPinVerified, q2CompleteLineagePinned,
      activeTrajectoryPinVerified, activeTrackletPinVerified, activeCompleteLineagePinned,
      q3PinnedTrajectoryPinVerified
    ].every(Boolean);
    assert(effectiveSnapshotPinsVerified);
    const q1DurableIdempotentReplay = q1Replay.replayed
      && requiredString(q1Replay.body.outputHash, "Q1 replay outputHash") === q1WorldOutputHash
      && sha256(trajectoryOutput(q1Replay)) === q1ValueHash;
    assert(q1DurableIdempotentReplay);
    const expectedProviderExecutions = 6; // Q1, Q4, Q2, ACTIVE, pinned h1, cross-scope.
    assert.equal(providerHttpExecuteCalls, expectedProviderExecutions);
    assert.equal(operationalProviderHttpExecuteCalls, 1);
    process.stdout.write(`${JSON.stringify({
      status: "PASS",
      gate: "GOWM_V07_HISTORY_GATEWAY_E2E",
      versions,
      provider: {
        providerId: manifest.provider.providerId,
        operationId: "history.get-trajectory",
        providerTransport: "HTTP",
        gatewayTransport: "HTTP",
        providerHttpExecuteCalls,
        intervalProviderId: operationalManifest.provider.providerId,
        intervalOperationId: intervalDescriptor.operationId,
        intervalProviderHttpExecuteCalls: operationalProviderHttpExecuteCalls,
        directProviderCallsFromValidationClient,
        gatewayHttpSubmissions
      },
      checks: {
        q1InitialRevisionNo: h1.revisionNo,
        intervalProviderPreview: intervalDescriptor.maturity === "PREVIEW",
        intervalProviderDiscoversResources: intervalDescriptor.snapshotPolicy.resourceResolution === "DISCOVER_RESOURCES",
        intervalProviderSnapshotPinVerified,
        q1SingleSubmissionTwoProviderDag,
        q1OperationalSnapshotMerged,
        q1HistoricalSnapshotMerged,
        intervalReferenceKeyHash,
        intervalReferenceKeyPassedUnchanged: sha256(query.executionIntervalReferenceKey) === intervalReferenceKeyHash
          && sha256(q1Trajectory.executionIntervalReferenceKey) === intervalReferenceKeyHash
          && historyProviderIntervalReferenceKeyHashes[0] === intervalReferenceKeyHash,
        intervalRevisionLineagePinned: h1.intervalRevisionId === intervalPin.revisionId,
        q1DurableIdempotentReplay,
        q1WorldOutputHash,
        q2LateDataRevisionNo: h2.revisionNo,
        q2DiffersFromQ1: q2ValueHash !== q1ValueHash,
        lateTrackletLineage: Number(lineage.rows[0]?.late_data_count) === 1,
        h2SupersedesH1: h2.supersedesRevisionId === h1.revisionId,
        h1H2InputLineagePinned: h1LineagePinned && h2LineagePinned,
        oldH1StillReadable: oldRevision.rows[0]?.content_hash === h1.contentHash,
        q3PinnedOldOutputHashPreserved: sha256(q3PinnedTrajectory) === q1ValueHash,
        q3CrossScopeFailClosed: crossScopeOutput.status === "NO_DATA" && crossScopeNoForeignIdentityLeak,
        q4CapturedAt: q4CapturedAt,
        q4HeadFreeFixedCapturedAt: q4Trajectory.trajectoryReferenceKey?.version === "1"
          && q4Snapshot.capturedAt === q4CapturedAt,
        activeLineagePinned,
        envelopeIncludesPausedMovement,
        activePauseExcluded: pauseExcluded,
        activeUnknownGapPreserved: Number(unknownActiveGap.rows[0]?.count) === 1 && activeGapPreserved,
        activeRequestedPeriodsExact,
        activePreviewExcludesPausedTime,
        effectiveSnapshotPinsVerified,
        validationClientGatewayOnly
      },
      sharedRuntimeMutated: false,
      externalModelQualification: false
    })}\n`);
  } finally {
    await Promise.allSettled([gatewayApp?.close(), providerApp?.close(), operationalProviderApp?.close()]);
    await pool.end();
  }
}

function fixtureIdentity(runId: string): FixtureIdentity {
  const suffix = runId.slice(0, 18);
  return {
    scopeA: `history-gateway-a-${suffix}`,
    scopeB: `history-gateway-b-${suffix}`,
    sourceKey: `history-source-${suffix}`,
    pipelineKey: `history-pipeline-${suffix}`,
    datastreamKey: `history-stream-${suffix}`,
    trackerSessionKey: `history-session-${suffix}`,
    targetKey: `history-target-${suffix}`,
    operationalTaskId: `history-task-${suffix}`,
    subjectReferenceKey: "",
    processingRunId: randomUUID(),
    clockModelId: ""
  };
}

async function seedFixtureFoundation(pool: pg.Pool, fixture: FixtureIdentity): Promise<void> {
  await pool.query(
    `INSERT INTO public.data_scope(scope_key,operational_domain,description)
     VALUES ($1,'TEST','v0.7 history Gateway E2E scope A'),($2,'TEST','v0.7 history Gateway E2E scope B')`,
    [fixture.scopeA, fixture.scopeB]
  );
  await pool.query(
    `INSERT INTO public.source_registry(source_key,data_scope_key,source_type,default_analysis_space_key)
     VALUES ($1,$2,'VALIDATION','default')`,
    [fixture.sourceKey, fixture.scopeA]
  );
  await pool.query(
    `INSERT INTO public.producer_pipeline(pipeline_key,source_key,pipeline_version,output_kind)
     VALUES ($1,$2,'0.7.0','CANONICAL_OBSERVATION')`,
    [fixture.pipelineKey, fixture.sourceKey]
  );
  await pool.query(
    `INSERT INTO public.datastream(datastream_key,source_key,data_scope_key,pipeline_key,schema_version)
     VALUES ($1,$2,$3,$4,'1.2')`,
    [fixture.datastreamKey, fixture.sourceKey, fixture.scopeA, fixture.pipelineKey]
  );
  await pool.query(
    `INSERT INTO public.processing_run(
       processing_run_id,processor_name,processor_version,config_hash,code_digest,
       deterministic,started_at,completed_at
     ) VALUES ($1,'gowm-v07-history-gateway-e2e','0.7.0',$2,$3,true,clock_timestamp(),clock_timestamp())`,
    [fixture.processingRunId, sha256({ fixture: fixture.scopeA }), "validation-only"]
  );
  const clock = await pool.query<{ clock_model_id: string }>(
    `INSERT INTO public.source_clock_model(
       source_key,model_version,clock_domain,residual_sigma_ms,estimation_method
     ) VALUES ($1,'history-gateway-v1','DECLARED_UTC',0,'VALIDATION_FIXED_UTC')
     RETURNING clock_model_id`,
    [fixture.sourceKey]
  );
  fixture.clockModelId = requiredString(clock.rows[0]?.clock_model_id, "clock model id");
  await pool.query(
    `INSERT INTO public.world_object(id,object_type,properties,data_scope_key)
     VALUES ($1,'VEHICLE','{}'::jsonb,$2)`,
    [fixture.targetKey, fixture.scopeA]
  );
  const subject = await pool.query<{ reference_key: string }>(
    `SELECT reference_key FROM public.world_reference_identity
     WHERE entity_kind='WORLD_OBJECT' AND internal_id=$1 AND data_scope_key=$2`,
    [fixture.targetKey, fixture.scopeA]
  );
  fixture.subjectReferenceKey = requiredString(subject.rows[0]?.reference_key, "subject reference key");
}

async function seedTaskEvents(pool: pg.Pool, fixture: FixtureIdentity): Promise<void> {
  const repository = new OperationalEventRepository(pool);
  const eventTypes = [
    ["EXECUTION_STARTED_OBSERVED", "2026-08-30T00:00:00.000Z"],
    ["EXECUTION_PROGRESS_OBSERVED", "2026-08-30T00:00:02.000Z"],
    ["EXECUTION_PAUSED_OBSERVED", "2026-08-30T00:00:04.000Z"],
    ["EXECUTION_RESUMED_OBSERVED", "2026-08-30T00:00:06.000Z"],
    ["EXECUTION_STOPPED_OBSERVED", "2026-08-30T00:00:10.000Z"]
  ] as const;
  for (const [eventType, eventTime] of eventTypes) {
    const eventId = `history-event-${eventType.toLowerCase()}-${fixture.operationalTaskId}`;
    await repository.insert({
      dataScopeKey: fixture.scopeA,
      sourceAuthority: "history-gateway-e2e",
      sourceEventKey: eventId,
      sourceRevisionNo: 1,
      eventId,
      operationalTaskId: fixture.operationalTaskId,
      eventType,
      eventTime,
      actorReferenceKeys: [],
      targetReferenceKeys: [],
      payload: { taskType: "HISTORY_GATEWAY_E2E" },
      confidence: 1,
      provenance: [{
        evidenceId: `evidence-${eventId}`,
        authority: "history-gateway-e2e",
        evidenceType: "VALIDATION_EVENT",
        observedAt: eventTime
      }]
    }, new Date().toISOString());
  }
}

async function seedInitialPositions(pool: pg.Pool, fixture: FixtureIdentity): Promise<void> {
  const points = [
    { ordinal: 1, phenomenonTime: "2026-08-30T00:00:00.000Z", x: 448_000, y: 4_417_000, manualCutBefore: false },
    { ordinal: 2, phenomenonTime: "2026-08-30T00:00:01.500Z", x: 448_001.5, y: 4_417_000, manualCutBefore: false },
    { ordinal: 3, phenomenonTime: "2026-08-30T00:00:02.000Z", x: 448_002, y: 4_417_000, manualCutBefore: false },
    { ordinal: 4, phenomenonTime: "2026-08-30T00:00:03.000Z", x: 448_003, y: 4_417_000, manualCutBefore: true },
    { ordinal: 5, phenomenonTime: "2026-08-30T00:00:03.500Z", x: 448_003.5, y: 4_417_000, manualCutBefore: false },
    { ordinal: 6, phenomenonTime: "2026-08-30T00:00:04.000Z", x: 448_004, y: 4_417_000, manualCutBefore: false },
    { ordinal: 7, phenomenonTime: "2026-08-30T00:00:05.000Z", x: 448_005, y: 4_417_000, manualCutBefore: false },
    { ordinal: 8, phenomenonTime: "2026-08-30T00:00:06.000Z", x: 448_006, y: 4_417_000, manualCutBefore: true },
    { ordinal: 9, phenomenonTime: "2026-08-30T00:00:08.000Z", x: 448_008, y: 4_417_000, manualCutBefore: false },
    { ordinal: 10, phenomenonTime: "2026-08-30T00:00:10.000Z", x: 448_010, y: 4_417_000, manualCutBefore: false }
  ];
  for (const point of points) await insertPosition(pool, fixture, point);
  await pool.query(
    `INSERT INTO public.entity_binding(
       data_scope_key,source_key,source_local_target_id,tracker_session_key,
       world_object_id,binding_status,method,method_version,
       evidence_observation_id,confidence
     ) VALUES ($1,$2,$3,$4,$3,'CONFIRMED','GOWM_V07_HISTORY_GATEWAY_E2E','0.7.0',$5,1)`,
    [
      fixture.scopeA,
      fixture.sourceKey,
      fixture.targetKey,
      fixture.trackerSessionKey,
      `history-position-1-${fixture.targetKey}`
    ]
  );
}

async function insertPosition(
  pool: pg.Pool,
  fixture: FixtureIdentity,
  point: { ordinal: number; phenomenonTime: string; x: number; y: number; manualCutBefore: boolean }
): Promise<void> {
  const observationId = `history-position-${point.ordinal}-${fixture.targetKey}`;
  const measurementId = randomUUID();
  const timeSolutionId = randomUUID();
  const receivedAt = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.world_observation(
         observation_id,observer_type,observer_id,subject_type,subject_id,
         observation_type,geometry,value,confidence,observed_at,received_at,source,
         correlation_id,metadata,data_scope_key,source_record_key,source_revision_no,
         origin_kind,source_local_target_id,tracker_session_id,datastream_key,
         producer_pipeline_key,upstream_received_time,raw_reference,payload_hash,
         entity_binding_status
       ) VALUES (
         $1,'VALIDATION_SENSOR',$2,'VEHICLE',$3,'position',
         ST_SetSRID(ST_MakePoint(116.4,39.9),4326),'{}',1,$4,$5,$2,
         $6,'{}',$7,$1,1,'SIMULATION',$3,$8,$9,$10,$5,$11,$12,'DECLARED'
       )`,
      [
        observationId, fixture.sourceKey, fixture.targetKey, point.phenomenonTime,
        receivedAt, fixture.operationalTaskId, fixture.scopeA, fixture.trackerSessionKey,
        fixture.datastreamKey, fixture.pipelineKey, `inline://history-gateway/${point.ordinal}`,
        sha256({ observationId, point })
      ]
    );
    await client.query(
      `INSERT INTO public.world_observation_head(source_key,source_record_key,current_observation_id)
       VALUES ($1,$2,$2)`,
      [fixture.sourceKey, observationId]
    );
    await client.query(
      `INSERT INTO public.observation_time_solution(
         time_solution_id,observation_id,clock_model_id,processing_run_id,
         phenomenon_time_estimate,phenomenon_time_window,uncertainty_seconds,solution_method
       ) VALUES ($1,$2,$3,$4,$5,span($5::timestamptz,$5::timestamptz+interval '1 millisecond',true,false),0,'VALIDATION_FIXED_UTC')`,
      [timeSolutionId, observationId, fixture.clockModelId, fixture.processingRunId, point.phenomenonTime]
    );
    await client.query(
      `INSERT INTO public.measurement(
         measurement_id,observation_id,time_solution_id,processing_run_id,
         measurement_key,measurement_stage,observed_property,result_kind,
         source_geometry,measurement_model,measurement_model_version,
         algorithm_confidence,quality_score,continuity_token,manual_cut_before,
         command_fingerprint
       ) VALUES (
         $1,$2,$3,$4,'position','NORMALIZED','position','POSITION',
         ST_SetSRID(ST_MakePoint(116.4,39.9),4326),
         'GOWM_V07_HISTORY_GATEWAY_E2E','0.7.0',1,1,$5,$6,$7
       )`,
      [
        measurementId, observationId, timeSolutionId, fixture.processingRunId,
        `${fixture.trackerSessionKey}:continuous`, point.manualCutBefore,
        sha256({ observationId, measurementId, point })
      ]
    );
    await client.query(
      `INSERT INTO public.position_measurement(
         measurement_id,analysis_space_key,source_position,position,
         accuracy_radius_m,accuracy_model,accuracy_confidence
       ) VALUES (
         $1,'default',ST_SetSRID(ST_MakePoint(116.4,39.9),4326),
         ST_SetSRID(ST_MakePoint($2,$3),32650),1,'HARD_RADIUS',0.95
       )`,
      [measurementId, point.x, point.y]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedCompleteWatermark(pool: pg.Pool, fixture: FixtureIdentity): Promise<void> {
  await pool.query(
    `INSERT INTO public.pipeline_watermark_revision(
       datastream_key,producer_pipeline_key,processing_run_id,clock_model_id,
       time_basis,closed_through_event_time,allowed_lateness,last_received_time,
       completeness_state
     ) VALUES ($1,$2,$3,$4,'CLOCK_MODEL','2026-08-30T00:01:00Z',interval '0',clock_timestamp(),'COMPLETE')`,
    [fixture.datastreamKey, fixture.pipelineKey, fixture.processingRunId, fixture.clockModelId]
  );
}

async function projectOperationalAndHistory(pool: pg.Pool, fixture: FixtureIdentity, workerId: string): Promise<void> {
  await new OperationalProjectionRepository(pool).projectPending(1_000);
  const coordinator = new HistoricalProjectionCoordinator({
    intervals: new PostgresTaskIntervalProjectionRepository(pool),
    tracklets: new PostgresTrackletProjectionRepository(pool)
  });
  const result = await coordinator.tick({ workerId, batchSize: 100, leaseSeconds: 60, retryDelayMs: 0 });
  assert.equal(result.historicalProjectionFailures, 0, JSON.stringify(result));
}

function historicalQuery(
  fixture: FixtureIdentity,
  executionIntervalReferenceKey: IntervalReferenceKey
): GowmV07HistoricalTrajectoryQuery {
  return {
    subjectReferenceKey: {
      namespace: "gowm",
      kind: "WORLD_OBJECT",
      id: fixture.subjectReferenceKey,
      version: "1"
    },
    executionIntervalReferenceKey: structuredClone(executionIntervalReferenceKey),
    phaseScope: "EXECUTION_ENVELOPE",
    sourceSelection: {
      mode: "EXPLICIT_SOURCE",
      sourceKey: fixture.sourceKey,
      trackerSessionKey: fixture.trackerSessionKey
    },
    sourceSelectionProfileReferenceKey: {
      namespace: "gowm.history",
      kind: "HISTORY_METHOD_PROFILE",
      id: "trajectory-single-authoritative-v1",
      version: "1.0"
    },
    analysisSpaceReferenceKey: {
      namespace: "gowm",
      kind: "ANALYSIS_SPACE",
      id: "default",
      version: "1"
    },
    maximumInlinePoints: 100
  };
}

async function loadOperationalTaskReferenceKey(
  pool: pg.Pool,
  fixture: FixtureIdentity
): Promise<GowmV07TaskExecutionIntervalQuery["taskReferenceKey"]> {
  const result = await pool.query<{ reference_key: string }>(
    `SELECT reference_key
     FROM public.operational_task
     WHERE data_scope_key=$1 AND operational_task_id=$2`,
    [fixture.scopeA, fixture.operationalTaskId]
  );
  const referenceKey = requiredString(result.rows[0]?.reference_key, "operational task reference key");
  return { namespace: "gowm", kind: "OPERATIONAL_TASK", id: referenceKey, version: "1" };
}

async function loadCurrentIntervalPin(pool: pg.Pool, fixture: FixtureIdentity): Promise<IntervalPin> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT interval.reference_key,revision.interval_revision_id,revision.revision_no,revision.content_hash
     FROM gowm_history.task_execution_interval interval
     JOIN gowm_history.task_execution_interval_head head USING (interval_id)
     JOIN gowm_history.task_execution_interval_revision revision
       ON revision.interval_revision_id=head.current_revision_id
     WHERE interval.data_scope_key=$1 AND interval.operational_task_id=$2 AND interval.execution_no=1`,
    [fixture.scopeA, fixture.operationalTaskId]
  );
  const row = result.rows[0];
  assert(row, "projected task execution interval is missing");
  return {
    referenceKey: {
      namespace: "gowm",
      kind: "TASK_EXECUTION_INTERVAL",
      id: requiredString(row.reference_key, "interval reference key"),
      version: String(requiredInteger(row.revision_no, "interval revision number"))
    },
    revisionId: requiredString(row.interval_revision_id, "interval revision id"),
    contentHash: digest(row.content_hash, "interval content hash")
  };
}

async function loadTrajectoryPin(pool: pg.Pool, revisionId: string): Promise<TrajectoryPin> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT identity.historical_trajectory_id,identity.reference_key,
            revision.revision_no,revision.trajectory_revision_id,
            revision.analysis_id,revision.interval_revision_id,revision.input_set_hash,
            revision.content_hash,revision.supersedes_revision_id,revision.created_at
     FROM gowm_history.historical_trajectory_revision revision
     JOIN gowm_history.historical_trajectory identity USING (historical_trajectory_id)
     WHERE revision.trajectory_revision_id=$1::uuid`,
    [revisionId]
  );
  const row = result.rows[0];
  assert(row, "materialized historical trajectory revision is missing");
  return {
    historicalTrajectoryId: requiredString(row.historical_trajectory_id, "historical trajectory id"),
    referenceKey: requiredString(row.reference_key, "trajectory reference key"),
    revisionNo: requiredInteger(row.revision_no, "trajectory revision_no"),
    revisionId: requiredString(row.trajectory_revision_id, "trajectory revision id"),
    analysisId: requiredString(row.analysis_id, "trajectory analysis id"),
    intervalRevisionId: requiredString(row.interval_revision_id, "trajectory interval revision id"),
    inputSetHash: digest(row.input_set_hash, "trajectory input set hash"),
    contentHash: digest(row.content_hash, "trajectory content hash"),
    ...(row.supersedes_revision_id === null
      ? {}
      : { supersedesRevisionId: requiredString(row.supersedes_revision_id, "supersedes revision id") }),
    createdAt: iso(row.created_at)
  };
}

async function assertTrajectoryTrackletLineage(
  pool: pg.Pool,
  trajectory: TrajectoryPin,
  tracklet: TrackletPin
): Promise<boolean> {
  const resources = await pool.query<Record<string, unknown>>(
    `SELECT input_kind,resource_id,resource_version,resource_content_hash
     FROM gowm_history.historical_trajectory_input
     WHERE trajectory_revision_id=$1::uuid
       AND input_kind IN ('TRACKLET_VERSION','TRACKLET_FINALIZATION_REVISION')
     ORDER BY input_kind`,
    [trajectory.revisionId]
  );
  const trackletInput = resources.rows.find((row) => row.input_kind === "TRACKLET_VERSION");
  const finalizationInput = resources.rows.find((row) => row.input_kind === "TRACKLET_FINALIZATION_REVISION");
  assert(trackletInput, "trajectory Tracklet input lineage is missing");
  assert(finalizationInput, "trajectory finalization input lineage is missing");
  assert.equal(requiredString(trackletInput.resource_id, "Tracklet lineage resource id"), tracklet.trackletVersionId);
  assert.equal(requiredString(trackletInput.resource_version, "Tracklet lineage resource version"), String(tracklet.versionNo));
  assert.equal(digest(trackletInput.resource_content_hash, "Tracklet lineage resource hash"), tracklet.contentHash);
  assert.equal(requiredString(finalizationInput.resource_id, "finalization lineage resource id"), tracklet.finalizationRevisionId);
  assert.equal(
    requiredString(finalizationInput.resource_version, "finalization lineage resource version"),
    String(tracklet.finalizationRevisionNo)
  );
  assert.equal(
    digest(finalizationInput.resource_content_hash, "finalization lineage resource hash"),
    tracklet.finalizationContentHash
  );
  const segments = await pool.query<{ source_tracklet_version_id: string; count: number }>(
    `SELECT source_tracklet_version_id,count(*)::integer AS count
     FROM gowm_history.historical_trajectory_segment
     WHERE trajectory_revision_id=$1::uuid
     GROUP BY source_tracklet_version_id`,
    [trajectory.revisionId]
  );
  assert.equal(segments.rows.length, 1, "trajectory must retain one exact source Tracklet version");
  assert.equal(segments.rows[0]?.source_tracklet_version_id, tracklet.trackletVersionId);
  assert(Number(segments.rows[0]?.count) > 0, "trajectory source segment lineage is empty");
  return resources.rows.length === 2
    && segments.rows.length === 1
    && segments.rows[0]?.source_tracklet_version_id === tracklet.trackletVersionId
    && Number(segments.rows[0]?.count) > 0;
}

async function assertTrajectoryCompleteLineage(
  pool: pg.Pool,
  trajectory: TrajectoryPin,
  snapshot: GowmV07QuerySnapshotManifest
): Promise<boolean> {
  const inputs = await pool.query<Record<string, unknown>>(
    `SELECT input_no,input_kind,resource_namespace,resource_kind,resource_id,
            resource_version,resource_content_hash,pinning,authority,
            analysis_input_no,analysis_input_set_kind
     FROM gowm_history.historical_trajectory_input
     WHERE trajectory_revision_id=$1::uuid
     ORDER BY input_no`,
    [trajectory.revisionId]
  );
  const requiredKinds = [
    "TASK_INTERVAL_REVISION",
    "TRACKLET_VERSION",
    "TRACKLET_FINALIZATION_REVISION",
    "METHOD_PROFILE",
    "ANALYSIS_SPACE",
    "TASK_EVENT_SET",
    "TRACKLET_INPUT_SET",
    "TIME_SOLUTION_SET",
    "WATERMARK_SET"
  ];
  for (const kind of requiredKinds) {
    assert(inputs.rows.some((row) => row.input_kind === kind), `trajectory lineage is missing ${kind}`);
  }
  for (const row of inputs.rows) {
    assert.equal(row.pinning, "PINNED");
    assertSnapshotPin(
      snapshot,
      requiredString(row.resource_kind, "lineage resource kind"),
      `${requiredString(row.resource_namespace, "lineage resource namespace")}:${requiredString(row.resource_id, "lineage resource id")}`,
      requiredString(row.resource_version, "lineage resource version"),
      digest(row.resource_content_hash, "lineage resource content hash")
    );
  }
  const historyInputSetPinned = assertSnapshotPin(
    snapshot,
    "HISTORY_INPUT_SET",
    `gowm:input-set-${trajectory.inputSetHash.slice(7)}`,
    String(trajectory.revisionNo),
    trajectory.inputSetHash
  );

  const directRows = inputs.rows.filter((row) => row.analysis_input_no !== null);
  const analysisResources = await pool.query<Record<string, unknown>>(
    `SELECT input_no,resource_namespace,resource_kind,resource_id,resource_version,
            resource_content_hash,pinning,authority
     FROM public.analysis_resource_input
     WHERE analysis_id=$1::uuid
     ORDER BY input_no`,
    [trajectory.analysisId]
  );
  assert.equal(analysisResources.rows.length, directRows.length, "analysis resource lineage count differs from trajectory inputs");
  for (const row of directRows) {
    const inputNo = requiredInteger(row.analysis_input_no, "analysis input number");
    const analysisRow = analysisResources.rows.find((candidate) => requiredInteger(candidate.input_no, "analysis input number") === inputNo);
    assert(analysisRow, `analysis resource input ${inputNo} is missing`);
    for (const field of [
      "resource_namespace", "resource_kind", "resource_id", "resource_version",
      "resource_content_hash", "pinning", "authority"
    ]) {
      assert.equal(analysisRow[field], row[field], `analysis resource input ${inputNo} differs at ${field}`);
    }
  }

  const setRows = inputs.rows.filter((row) => row.analysis_input_set_kind !== null);
  const analysisSets = await pool.query<Record<string, unknown>>(
    `SELECT input_set_kind,item_count,item_set_digest,authority
     FROM public.analysis_input_set
     WHERE analysis_id=$1::uuid
     ORDER BY input_set_kind`,
    [trajectory.analysisId]
  );
  assert.equal(analysisSets.rows.length, setRows.length, "analysis input-set lineage count differs from trajectory inputs");
  for (const row of setRows) {
    const kind = requiredString(row.analysis_input_set_kind, "analysis input-set kind");
    const analysisSet = analysisSets.rows.find((candidate) => candidate.input_set_kind === kind);
    assert(analysisSet, `analysis input set ${kind} is missing`);
    assert.equal(analysisSet.item_set_digest, row.resource_content_hash, `analysis input set ${kind} digest differs`);
    assert.equal(analysisSet.authority, row.authority, `analysis input set ${kind} authority differs`);
    assert(requiredInteger(analysisSet.item_count, `analysis input set ${kind} item count`) >= 0);
  }
  return historyInputSetPinned
    && requiredKinds.every((kind) => inputs.rows.some((row) => row.input_kind === kind))
    && analysisResources.rows.length === directRows.length
    && analysisSets.rows.length === setRows.length;
}

async function databaseNow(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ captured_at: Date | string }>(
    "SELECT clock_timestamp() AS captured_at"
  );
  return iso(result.rows[0]?.captured_at);
}

async function loadCurrentTrackletPin(pool: pg.Pool, fixture: FixtureIdentity): Promise<TrackletPin> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT version.tracklet_version_id,version.version_no,
            CASE WHEN version.content_hash ~ '^[0-9a-f]{64}$'
              THEN 'sha256:' || version.content_hash ELSE version.content_hash END AS content_hash,
            version.created_at,
            finalization.finalization_revision_id,
            finalization.revision_no AS finalization_revision_no,
            finalization.content_hash AS finalization_content_hash,
            finalization.finalization_state,finalization.created_at AS finalization_created_at
     FROM public.mobility_tracklet tracklet
     JOIN public.mobility_tracklet_head head USING (tracklet_id)
     JOIN public.mobility_tracklet_version version
       ON version.tracklet_version_id=head.current_version_id
     JOIN gowm_history.tracklet_finalization_head finalization_head
       ON finalization_head.tracklet_version_id=version.tracklet_version_id
     JOIN gowm_history.tracklet_finalization_revision finalization
       ON finalization.finalization_revision_id=finalization_head.current_finalization_revision_id
     WHERE tracklet.data_scope_key=$1 AND tracklet.source_key=$2
       AND tracklet.source_local_target_id=$3 AND tracklet.tracker_session_key=$4
       AND tracklet.analysis_space_key='default'`,
    [fixture.scopeA, fixture.sourceKey, fixture.targetKey, fixture.trackerSessionKey]
  );
  const row = result.rows[0];
  assert(row, "current Tracklet/finalization pin is missing");
  return {
    trackletVersionId: requiredString(row.tracklet_version_id, "tracklet version id"),
    versionNo: requiredInteger(row.version_no, "tracklet version no"),
    contentHash: digest(row.content_hash, "tracklet content hash"),
    createdAt: iso(row.created_at),
    finalizationRevisionId: requiredString(row.finalization_revision_id, "finalization revision id"),
    finalizationRevisionNo: requiredInteger(row.finalization_revision_no, "finalization revision no"),
    finalizationContentHash: digest(row.finalization_content_hash, "finalization content hash"),
    finalizationState: requiredString(row.finalization_state, "finalization state") as TrackletPin["finalizationState"],
    finalizationCreatedAt: iso(row.finalization_created_at)
  };
}

function gatewayRuntime(
  pool: pg.Pool,
  providers: readonly GatewayProviderRegistration[],
  fixture: FixtureIdentity,
  runId: string
): { app: FastifyApp; runtime: WorldQueryRuntime; store: PostgresQueryPlanStore } {
  const registry = new CapabilityRegistry();
  for (const provider of providers) registry.register({ ...provider, approved: true });
  const records = new PostgresGatewayRecordStore(pool);
  const store = new PostgresQueryPlanStore(pool);
  const direct = new DirectExecutionService({
    registry,
    circuits: new ProviderCircuitBreaker(),
    idempotency: new PostgresGatewayIdempotencyStore(pool, { leaseOwner: `history-gateway-${runId}` }),
    audit: new MemoryAuditSink(),
    gatewayId: `history-gateway-${runId}`,
    policyVersion: "history-gateway-e2e/1.0",
    attestationIssuer: `history-gateway-${runId}`,
    records
  });
  const runtime = new WorldQueryRuntime({
    validator: new QueryPlanValidator(registry),
    directExecution: direct,
    store,
    autoRunAsync: false
  });
  const app = buildGatewayApp({
    registry,
    directExecution: direct,
    records,
    worldQueries: runtime,
    authenticate: async (request): Promise<GatewayPrincipal> => {
      const claim = typeof request.headers["x-validation-scope"] === "string"
        ? request.headers["x-validation-scope"]
        : fixture.scopeA;
      if (claim !== fixture.scopeA && claim !== fixture.scopeB) throw new Error("invalid validation scope");
      return {
        principalRef: `principal:history-gateway:${claim}`,
        authenticationMethod: "TEST_ATTESTED",
        authenticatedAt: new Date().toISOString(),
        dataScopeClaim: claim,
        allowExperimental: true
      };
    },
    logger: process.env.GOWM_E2E_DEBUG === "1"
  });
  return { app, runtime, store };
}

function oneNodeSubmission(
  queryId: string,
  descriptor: CapabilityDescriptor,
  input: GowmV07HistoricalTrajectoryQuery,
  snapshotPolicy: NonNullable<WorldQuerySubmission["snapshotPolicy"]>
): WorldQuerySubmission {
  const requestPort = descriptor.ports.inputs.find((port) => port.name === "request");
  const resultPort = descriptor.ports.outputs.find((port) => port.name === "result");
  assert(requestPort && resultPort, "historical Provider manifest is missing request/result ports");
  const port = (value: typeof requestPort): WorldQueryPlanV2SchemaPort => ({
    schemaUri: value.schemaUri,
    schemaHash: value.schemaHash,
    valueKind: value.valueKind,
    unitSemantics: value.unitSemantics
  });
  return {
    requestId: `request-${queryId}`,
    idempotencyKey: `idempotency-${queryId}`,
    parameterSchemaHash: getContractSchemaHash("world-query-parameters.schema.json"),
    parameters: {},
    snapshotPolicy,
    plan: {
      queryPlanVersion: "2.0",
      queryId,
      nodes: [{
        nodeId: "historicalTrajectory",
        operation: {
          operationId: descriptor.operationId,
          operationVersion: descriptor.operationVersion,
          inputSchemaHash: descriptor.inputSchemaHash,
          outputSchemaHash: descriptor.outputSchemaHash
        },
        inputs: {
          request: { kind: "LITERAL", port: port(requestPort), value: input }
        },
        failurePolicy: "FAIL_FAST",
        budget: {
          maximumRows: descriptor.limits.maximumRows ?? 1_000,
          maximumCandidates: descriptor.limits.maximumCandidates ?? 5_000,
          maximumOutputBytes: descriptor.limits.maximumOutputBytes ?? 16_777_216,
          maximumExecutionMs: descriptor.execution.maximumTimeoutMs
        }
      }],
      outputs: [{
        name: "trajectory",
        binding: {
          kind: "NODE_OUTPUT",
          nodeId: "historicalTrajectory",
          outputPort: "result",
          port: port(resultPort)
        }
      }],
      budgets: {
        maximumNodes: 1,
        maximumDepth: 1,
        maximumRows: descriptor.limits.maximumRows ?? 1_000,
        maximumCandidates: descriptor.limits.maximumCandidates ?? 5_000,
        maximumOutputBytes: descriptor.limits.maximumOutputBytes ?? 16_777_216,
        maximumExecutionMs: descriptor.execution.maximumTimeoutMs
      }
    }
  };
}

function intervalTrajectorySubmission(
  queryId: string,
  intervalDescriptor: CapabilityDescriptor,
  intervalInput: GowmV07TaskExecutionIntervalQuery,
  historyDescriptor: CapabilityDescriptor,
  historyInput: GowmV07HistoricalTrajectoryQuery
): WorldQuerySubmission {
  const intervalRequestPort = intervalDescriptor.ports.inputs.find((candidate) => candidate.name === "request");
  const intervalResultPort = intervalDescriptor.ports.outputs.find((candidate) => candidate.name === "result");
  const intervalReferencePort = intervalDescriptor.ports.outputs.find(
    (candidate) => candidate.name === "executionIntervalReferenceKey"
  );
  const historyResultPort = historyDescriptor.ports.outputs.find((candidate) => candidate.name === "result");
  assert(intervalRequestPort && intervalResultPort && historyResultPort,
    "composed Provider manifests are missing canonical request/result ports");
  assert(intervalReferencePort, "interval Provider manifest is missing its controlled ReferenceKey output port");
  assert.equal(intervalReferencePort.path, "/intervals/0/executionIntervalReferenceKey");
  assert.equal(intervalReferencePort.valueKind, "REFERENCE_KEY");
  assert(historyInput.analysisSpaceReferenceKey, "history query analysis-space pin is required by this canary");
  assert(historyInput.maximumInlinePoints !== undefined, "history query inline budget is required by this canary");
  const port = (value: typeof intervalRequestPort): WorldQueryPlanV2SchemaPort => ({
    schemaUri: value.schemaUri,
    schemaHash: value.schemaHash,
    valueKind: value.valueKind,
    unitSemantics: value.unitSemantics
  });
  const leafPort = (
    schemaUri: string,
    valueKind: WorldQueryPlanV2SchemaPort["valueKind"],
    unitSemantics: WorldQueryPlanV2SchemaPort["unitSemantics"] = "UNSPECIFIED"
  ): WorldQueryPlanV2SchemaPort => ({
    schemaUri,
    schemaHash: getContractSchemaHash(schemaUri),
    valueKind,
    unitSemantics
  });
  const referencePort = leafPort("urn:gowm:v0.7:reference-key", "REFERENCE_KEY");
  const stringPort = leafPort("urn:gowm:v0.2:value:string", "SCALAR");
  const objectPort = leafPort("urn:gowm:v0.2:value:object", "ANY");
  const integerPort = leafPort("urn:gowm:v0.2:value:integer", "SCALAR", "DISCRETE");
  const literal = (value: unknown, bindingPort: WorldQueryPlanV2SchemaPort, targetPath: string) => ({
    kind: "LITERAL" as const,
    port: bindingPort,
    value,
    targetPath
  });
  const nodeBudget = (descriptor: CapabilityDescriptor) => ({
    maximumRows: descriptor.limits.maximumRows ?? 1_000,
    maximumCandidates: descriptor.limits.maximumCandidates ?? 5_000,
    maximumOutputBytes: descriptor.limits.maximumOutputBytes ?? 16_777_216,
    maximumExecutionMs: descriptor.execution.maximumTimeoutMs
  });
  return {
    requestId: `request-${queryId}`,
    idempotencyKey: `idempotency-${queryId}`,
    parameterSchemaHash: getContractSchemaHash("world-query-parameters.schema.json"),
    parameters: {},
    snapshotPolicy: { mode: "LATEST_AT_START" },
    plan: {
      queryPlanVersion: "2.0",
      queryId,
      nodes: [{
        nodeId: "executionIntervals",
        operation: {
          operationId: intervalDescriptor.operationId,
          operationVersion: intervalDescriptor.operationVersion,
          inputSchemaHash: intervalDescriptor.inputSchemaHash,
          outputSchemaHash: intervalDescriptor.outputSchemaHash
        },
        inputs: {
          request: { kind: "LITERAL", port: port(intervalRequestPort), value: intervalInput }
        },
        failurePolicy: "FAIL_FAST",
        budget: nodeBudget(intervalDescriptor)
      }, {
        nodeId: "historicalTrajectory",
        operation: {
          operationId: historyDescriptor.operationId,
          operationVersion: historyDescriptor.operationVersion,
          inputSchemaHash: historyDescriptor.inputSchemaHash,
          outputSchemaHash: historyDescriptor.outputSchemaHash
        },
        inputs: {
          subjectReferenceKey: literal(historyInput.subjectReferenceKey, referencePort, "/subjectReferenceKey"),
          executionIntervalReferenceKey: {
            kind: "NODE_OUTPUT",
            port: port(intervalReferencePort),
            nodeId: "executionIntervals",
            outputPort: intervalReferencePort.name,
            path: intervalReferencePort.path,
            targetPath: "/executionIntervalReferenceKey"
          },
          phaseScope: literal(historyInput.phaseScope, stringPort, "/phaseScope"),
          sourceSelection: literal(historyInput.sourceSelection, objectPort, "/sourceSelection"),
          sourceSelectionProfileReferenceKey: literal(
            historyInput.sourceSelectionProfileReferenceKey,
            referencePort,
            "/sourceSelectionProfileReferenceKey"
          ),
          analysisSpaceReferenceKey: literal(
            historyInput.analysisSpaceReferenceKey,
            referencePort,
            "/analysisSpaceReferenceKey"
          ),
          maximumInlinePoints: literal(historyInput.maximumInlinePoints, integerPort, "/maximumInlinePoints")
        },
        failurePolicy: "FAIL_FAST",
        budget: nodeBudget(historyDescriptor)
      }],
      outputs: [{
        name: "intervals",
        binding: {
          kind: "NODE_OUTPUT",
          nodeId: "executionIntervals",
          outputPort: "result",
          port: port(intervalResultPort)
        }
      }, {
        name: "trajectory",
        binding: {
          kind: "NODE_OUTPUT",
          nodeId: "historicalTrajectory",
          outputPort: "result",
          port: port(historyResultPort)
        }
      }],
      budgets: {
        maximumNodes: 2,
        maximumDepth: 2,
        maximumRows: (intervalDescriptor.limits.maximumRows ?? 1_000) + (historyDescriptor.limits.maximumRows ?? 1_000),
        maximumCandidates: (intervalDescriptor.limits.maximumCandidates ?? 5_000) + (historyDescriptor.limits.maximumCandidates ?? 5_000),
        maximumOutputBytes: (intervalDescriptor.limits.maximumOutputBytes ?? 16_777_216)
          + (historyDescriptor.limits.maximumOutputBytes ?? 16_777_216),
        maximumExecutionMs: intervalDescriptor.execution.maximumTimeoutMs + historyDescriptor.execution.maximumTimeoutMs
      }
    }
  };
}

async function submitGateway(
  base: string,
  submission: WorldQuerySubmission,
  scope: string,
  asyncMode = false
): Promise<GatewayResponse> {
  const response = await fetch(`${base}/v1/world-queries`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-validation-scope": scope,
      ...(asyncMode ? { prefer: "respond-async" } : {})
    },
    body: JSON.stringify(submission)
  });
  return {
    status: response.status,
    replayed: response.headers.get("idempotent-replay") === "true",
    body: await response.json() as JsonRecord
  };
}

function trajectoryOutput(response: GatewayResponse): GowmV07HistoricalTrajectoryResult {
  const outputs = requiredRecord(response.body.outputs, "world query outputs");
  return requiredRecord(outputs.trajectory, "trajectory output") as unknown as GowmV07HistoricalTrajectoryResult;
}

function intervalOutput(response: GatewayResponse): GowmV07TaskExecutionIntervalResult {
  const outputs = requiredRecord(response.body.outputs, "world query outputs");
  return requiredRecord(outputs.intervals, "execution interval output") as unknown as GowmV07TaskExecutionIntervalResult;
}

function nodeProviderSnapshot(response: GatewayResponse, nodeId: string): DataSnapshotContext {
  if (!Array.isArray(response.body.nodes)) throw new Error("world query nodes must be an array");
  const node = response.body.nodes.find((candidate) =>
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      && (candidate as JsonRecord).nodeId === nodeId
  );
  const nodeRecord = requiredRecord(node, `${nodeId} node`);
  const result = requiredRecord(nodeRecord.result, `${nodeId} result envelope`);
  return requiredRecord(result.dataSnapshot, `${nodeId} Provider DataSnapshot`) as unknown as DataSnapshotContext;
}

function assertProviderSnapshotMerged(
  providerSnapshot: DataSnapshotContext,
  effectiveSnapshot: GowmV07QuerySnapshotManifest
): boolean {
  for (const resource of providerSnapshot.resources) {
    const resourceId = `${resource.referenceKey.namespace}:${resource.referenceKey.id}`;
    const effective = effectiveSnapshot.resources.find((candidate) =>
      candidate.resourceKind === resource.referenceKey.kind && candidate.resourceId === resourceId
    );
    assert(effective, `${resource.referenceKey.kind}:${resourceId} is absent from the shared Effective Snapshot`);
    assert.equal(effective.version, resource.referenceKey.version);
    assert.equal(effective.pinning, resource.pinning);
    if (resource.digest !== undefined) assert.equal(effective.contentHash, resource.digest);
    if (resource.worldVersion !== undefined) assert.equal(effective.worldVersion, resource.worldVersion);
  }
  return true;
}

function snapshotManifest(response: GatewayResponse): GowmV07QuerySnapshotManifest {
  return requiredRecord(response.body.effectiveSnapshotManifest, "effective snapshot") as unknown as GowmV07QuerySnapshotManifest;
}

function pinnedManifest(source: GowmV07QuerySnapshotManifest, id: string): GowmV07QuerySnapshotManifest {
  const body = {
    querySnapshotId: id,
    mode: "PINNED" as const,
    consistency: "PINNED" as const,
    capturedAt: source.capturedAt,
    resources: structuredClone(source.resources)
  };
  return { ...body, manifestHash: sha256(body) };
}

function assertSnapshotPin(
  snapshot: GowmV07QuerySnapshotManifest,
  resourceKind: string,
  resourceId: string,
  version: string,
  contentHash: string
): boolean {
  const pin = snapshot.resources.find((resource) => resource.resourceKind === resourceKind && resource.resourceId === resourceId);
  assert(pin, `${resourceKind}:${resourceId} is absent from effective snapshot`);
  assert.equal(pin.version, version);
  assert.equal(pin.contentHash, contentHash);
  assert.equal(pin.pinning, "PINNED");
  return pin.version === version && pin.contentHash === contentHash && pin.pinning === "PINNED";
}

async function waitForDatabaseClockAfter(pool: pg.Pool, timestamp: string): Promise<void> {
  await pool.query(
    `SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)`,
    [timestamp]
  );
}

function listenerUrl(app: { server: { address(): string | { port: number } | null } }): URL {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("listener address is unavailable");
  return new URL(`http://127.0.0.1:${address.port}/`);
}

function emitDiagnosticError(component: string, error: unknown): void {
  if (process.env.GOWM_E2E_DEBUG !== "1") return;
  const chain: string[] = [];
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    chain.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  process.stderr.write(`GOWM_V07_E2E_DIAGNOSTIC ${component} ${chain.join(" <- ")}\n`);
}

function requiredDescriptor(manifest: CapabilityProviderManifest, operationId: string): CapabilityDescriptor {
  const descriptor = manifest.capabilities.find((candidate) => candidate.operationId === operationId);
  if (!descriptor) throw new Error(`${operationId} is absent from ${manifest.provider.providerId}`);
  return descriptor;
}

function requiredRecord(value: unknown, field: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as JsonRecord;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(result)) throw new Error(`${field} must be an integer`);
  return result;
}

function digest(value: unknown, field: string): `sha256:${string}` {
  const result = requiredString(value, field);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new Error(`${field} must be SHA-256`);
  return result as `sha256:${string}`;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid timestamp: ${String(value)}`);
  return date.toISOString();
}
