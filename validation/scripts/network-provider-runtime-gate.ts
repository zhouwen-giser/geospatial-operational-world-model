import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import type { ProviderExecutionRequest } from "../../packages/platform/contract-runtime/src/index.js";
import {
  buildNetworkTopology, compileTurnRestrictions, createConditionSnapshot, createCostProfile, createTravelProfile,
  PostgresNetworkProfileConditionWriter, PostgresNetworkTopologyWriter, PostgresNetworkTurnWriter, sha256,
  type MaterializedNetworkBuild, type MaterializedNetworkFeature
} from "../../packages/network-foundation/src/index.js";
import { ProviderProtocolError } from "../../packages/platform/provider-sdk/src/index.js";
import { createNetworkProvider } from "../../services/providers/network-provider/src/provider.js";
import type { NetworkSqlClient, NetworkSqlPool, Row } from "../../services/providers/network-provider/src/types.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FEATURE_NAMES = ["p", "q", "r", "s", "a", "b", "c", "d", "e", "f", "u", "v", "w", "t1", "t2", "x", "ambEast", "ambWest", "illegalTrack", "legalParallel"] as const;
type FeatureName = (typeof FEATURE_NAMES)[number];
const runId = requiredEnv("GOWM_V05_RUN_ID");
const composeProject = requiredEnv("GOWM_V05_COMPOSE_PROJECT");
const sourceDatabase = process.env.GOWM_P01_SOURCE_DATABASE ?? "gowm_v05_n04_20260825t0228";
if (process.env.ALLOW_GOWM_NETWORK_PROVIDER_GATE !== "YES") throw new Error("Set ALLOW_GOWM_NETWORK_PROVIDER_GATE=YES");
if (!/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId) || !/^[a-z0-9][a-z0-9_-]{2,127}$/u.test(composeProject) || !/^gowm_v05_[a-z0-9_]+$/u.test(sourceDatabase)) throw new Error("invalid P01 runtime identity");

const database = `gowm_v05_${runId.replaceAll("-", "_")}`;
const builderRole = `p01b_${runId.replaceAll("-", "_")}`;
const providerRole = `p01p_${runId.replaceAll("-", "_")}`;
const builderPassword = secret("builder");
const providerPassword = secret("provider");
const dockerEnvironment: NodeJS.ProcessEnv = { ...process.env, COMPOSE_PROJECT_NAME: composeProject, POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? "gowm_v05_local_test", STAS_DB_PASSWORD: process.env.STAS_DB_PASSWORD ?? "gowm_v05_stas_local_test" };
const evidence: { schemaVersion: string; phase: string; runId: string; composeProject: string; sourceDatabase: string; database: string; startedAt: string; finishedAt?: string; status: "RUNNING" | "PASS" | "FAIL"; commands: Array<{ command: string[]; status: "PASS" | "FAIL"; elapsedMs: number }>; acceptance: Record<string, string>; summary: null | Record<string, unknown>; errors: string[] } = {
  schemaVersion: "1.0", phase: "P01", runId, composeProject, sourceDatabase, database, startedAt: new Date().toISOString(), status: "RUNNING", commands: [], acceptance: {}, summary: null, errors: []
};

function docker(args: string[], redacted: string[] = args): string {
  const started = Date.now();
  try {
    const output = execFileSync("docker", args, { cwd: repositoryRoot, env: dockerEnvironment, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    evidence.commands.push({ command: ["docker", ...redacted], status: "PASS", elapsedMs: Date.now() - started });
    return output.trim();
  } catch (error) { evidence.commands.push({ command: ["docker", ...redacted], status: "FAIL", elapsedMs: Date.now() - started }); throw error; }
}
async function persist(): Promise<void> { evidence.finishedAt = new Date().toISOString(); await mkdir(resolve(repositoryRoot, "reports/gowm-v0.5"), { recursive: true }); await writeFile(resolve(repositoryRoot, `reports/gowm-v0.5/p01-runtime-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8"); }

let rolesCreated = false;
let proxyCreated = false;
const proxyName = `gowm-${runId}-postgres-proxy`;
let builderPool: Pool | undefined;
let providerPool: Pool | undefined;
try {
  const containerId = docker(["compose", "ps", "--quiet", "postgres"]);
  if (!containerId || docker(["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", containerId]) !== "healthy") throw new Error("validated PostgreSQL is unavailable");
  docker(["compose", "exec", "--no-TTY", "postgres", "createdb", "--username", "gowm", "--template", sourceDatabase, database]);
  docker(["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", database, "--set", "ON_ERROR_STOP=on", "--command", "CREATE EXTENSION IF NOT EXISTS pgrouting CASCADE"]);
  const migration = await readFile(resolve(repositoryRoot, "database/migrations/044_network_arc_heading_read_contract.sql"), "utf8");
  docker(["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", database, "--set", "ON_ERROR_STOP=on", "--command", migration], ["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", database, "--set", "ON_ERROR_STOP=on", "--command", "<migration 044_network_arc_heading_read_contract.sql>"]);
  const roleSql = `CREATE ROLE ${builderRole} LOGIN PASSWORD '${builderPassword}'; GRANT network_builder TO ${builderRole}; CREATE ROLE ${providerRole} LOGIN PASSWORD '${providerPassword}'; GRANT network_provider TO ${providerRole}`;
  docker(["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", database, "--set", "ON_ERROR_STOP=on", "--command", roleSql], ["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", database, "--set", "ON_ERROR_STOP=on", "--command", `<create ${builderRole}/${providerRole} with redacted passwords>`]);
  rolesCreated = true;
  const networks = JSON.parse(docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", containerId])) as Record<string, unknown>;
  const networkName = Object.keys(networks)[0]; if (!networkName) throw new Error("validated PostgreSQL network is unavailable");
  const proxyScript = "import net from 'node:net';const server=net.createServer((client)=>{const upstream=net.connect(5432,'postgres');client.pipe(upstream).pipe(client);const close=()=>{client.destroy();upstream.destroy()};client.on('error',close);upstream.on('error',close)});server.listen(5432,'0.0.0.0')";
  docker(["run", "--detach", "--name", proxyName, "--network", networkName, "--publish", "127.0.0.1::5432", "node:22-bookworm", "node", "--input-type=module", "--eval", proxyScript], ["run", "--detach", "--name", proxyName, "--network", networkName, "--publish", "127.0.0.1::5432", "node:22-bookworm", "<fixed TCP proxy>"]);
  proxyCreated = true;
  const proxyPort = Number(docker(["inspect", "--format", "{{(index (index .NetworkSettings.Ports \"5432/tcp\") 0).HostPort}}", proxyName]));
  if (!Number.isSafeInteger(proxyPort) || proxyPort < 1) throw new Error("P01 PostgreSQL proxy port is unavailable");

  builderPool = new Pool({ host: "127.0.0.1", port: proxyPort, database, user: builderRole, password: builderPassword, max: 2, connectionTimeoutMillis: 10_000 });
  providerPool = new Pool({ host: "127.0.0.1", port: proxyPort, database, user: providerRole, password: providerPassword, max: 4, connectionTimeoutMillis: 10_000 });
  providerPool.on("error", () => undefined);
  const fixture = await seedFixture(builderPool);
  const adapter: NetworkSqlPool = {
    async connect(): Promise<NetworkSqlClient> { const client = await providerPool!.connect(); return { async query<T extends Row = Row>(text: string, values?: readonly unknown[]) { const result = await client.query(text, values === undefined ? undefined : [...values]); return { rows: result.rows as T[], rowCount: result.rowCount }; }, release: () => client.release() }; },
    end: () => providerPool!.end()
  };
  const provider = createNetworkProvider({ pool: adapter, maximumMatrixPoints: 16, maximumSegments: 100, ambiguityScoreTolerance: 1_000 });
  const execute = async (operationId: string, input: unknown, suffix: string, deadlineMs = 30_000) => {
    const descriptor = provider.runtime.manifest.capabilities.find((candidate) => candidate.operationId === operationId);
    if (!descriptor) throw new Error(`missing operation ${operationId}`);
    const deadlineAt = new Date(Date.now() + deadlineMs).toISOString();
    const issuedAt = new Date().toISOString();
    const attestationExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const request: ProviderExecutionRequest = {
      providerProtocolVersion: "1.0", requestId: `p01_${suffix}`, gatewayRequestId: `p01_gateway_${suffix}`, idempotencyKey: `p01:${runId}:${suffix}`,
      operation: { operationId, operationVersion: descriptor.operationVersion, inputSchemaHash: descriptor.inputSchemaHash, outputSchemaHash: descriptor.outputSchemaHash }, input,
      securityContext: { principalRef: "principal:p01-runtime", authenticationMethod: "RUNTIME_ACCEPTANCE", authenticatedAt: new Date(Date.now() - 1_000).toISOString(), dataScopeClaim: fixture.dataScopeKey, datasetScopeClaim: fixture.datasetScopeKey, scopeAttestation: { issuer: "p01-runtime-gate", issuedAt, expiresAt: attestationExpiresAt, claimDigest: sha256({ runId, scope: fixture.datasetScopeKey }) } },
      gatewayContext: { gatewayId: "p01-runtime-gate", registryVersion: "gowm-v0.5", policyVersion: "p01" },
      executionPolicy: { deadlineAt, maximumInputBytes: 1_048_576, maximumResultBytes: 16_777_216, maximumCostClass: "HIGH" }
    };
    return provider.runtime.execute(request);
  };

  const graphInput = snapInput(fixture.baselineSnapshot, { coordinates: [0.0005, 0], crs: "EPSG:4326" }, 100, 8);
  const graph = await execute("network.graph.get", graphInput, "graph");
  assert((graph.output?.value as Row).graphVersion === fixture.baselineSnapshot.graphVersion, "graph get did not pin the fixture");
  pass("AC-P001", "manifest_and_graph_contract");

  const unique = output(await execute("network.snap.point", graphInput, "snap_unique"));
  assert(unique.status === "RESOLVED_UNIQUE", `unique snap status ${String(unique.status)}`); pass("AC-P002", "unique_directed_candidate");
  const ambiguousInput = snapInput(fixture.baselineSnapshot, { coordinates: [0.0505, 0.015], crs: "EPSG:4326" }, 50, 8);
  const ambiguous = output(await execute("network.snap.point", ambiguousInput, "snap_ambiguous"));
  assert(ambiguous.status === "AMBIGUOUS" && (ambiguous.candidates as unknown[]).length >= 2, "parallel snap was not ambiguous"); pass("AC-P003", "parallel_ambiguous");
  const heading = output(await execute("network.snap.point", { ...ambiguousInput, headingDegrees: 90 }, "snap_heading"));
  assert(heading.status === "RESOLVED_UNIQUE" && ((heading.candidates as Row[])[0]?.headingDifferenceMicrodegrees === 0), "heading did not rank the legal directed arc"); pass("AC-P004", "heading_ranked_legal_arc");
  const profileSnap = output(await execute("network.snap.point", snapInput(fixture.baselineSnapshot, { coordinates: [0.0605, 0.025], crs: "EPSG:4326" }, 100, 8), "snap_profile"));
  const profileCandidates = profileSnap.candidates as Row[];
  assert(profileCandidates.length > 0 && profileCandidates.every((candidate) => ((candidate.state as Row).sourceFeatureReferenceKey as Row)?.id !== featureId("illegalTrack")), "illegal TRACK arc leaked into snap"); pass("AC-P005", "profile_illegal_arc_excluded");
  const unreachable = output(await execute("network.snap.point", snapInput(fixture.baselineSnapshot, { coordinates: [100, 80], crs: "EPSG:4326" }, 1, 8), "snap_unreachable"));
  assert(unreachable.status === "UNREACHABLE", "remote point did not return UNREACHABLE"); pass("AC-P006", "unreachable");

  const partial = output(await execute("network.path.shortest", pathInput(fixture.baselineSnapshot, state(fixture.arc.t1, 250_000), state(fixture.arc.t2, 500_000), "SHORTEST_DISTANCE"), "partial"));
  const partialSegments = partial.segments as Row[];
  assert(partial.status === "COMPLETED" && partialSegments[0]?.startFractionPpm === 250_000 && partialSegments.at(-1)?.endFractionPpm === 500_000, "partial fractions changed"); pass("AC-P007", "exact_partial_fractions");
  const ordinary = output(await execute("network.path.shortest", pathInput(fixture.baselineSnapshot, state(fixture.arc.t1, 0), state(fixture.arc.t2, 1_000_000), "SHORTEST_DISTANCE"), "ordinary"));
  const pgrDistance = await pgrDifferential(builderPool, fixture.graphVersionId, fixture.profileIds.travel, fixture.profileIds.cost, fixture.conditionIds.baseline, fixture.arc.t1, fixture.arc.t2);
  assert((ordinary.metrics as Row).distanceMm === pgrDistance, `provider/pgr_dijkstra mismatch ${String((ordinary.metrics as Row).distanceMm)} != ${pgrDistance}`); pass("AC-P008", "directed_dijkstra_matches_pgrouting");
  const matrixResult = output(await execute("network.path.cost-matrix", { routingSnapshot: fixture.baselineSnapshot, points: [state(fixture.arc.t1, 0), state(fixture.arc.t2, 1_000_000), state(fixture.arc.x, 1_000_000)], objective: "SHORTEST_DISTANCE" }, "matrix"));
  assert(matrixResult.pointCount === 3 && (matrixResult.entries as Row[]).length === 9 && (matrixResult.entries as Row[]).some((entry) => entry.reachable === false), "matrix bounds/reachability mismatch"); pass("AC-P009", "bounded_cost_only_matrix");
  const noPath = output(await execute("network.path.shortest", pathInput(fixture.baselineSnapshot, state(fixture.arc.t1, 0), state(fixture.arc.x, 1_000_000), "SHORTEST_DISTANCE"), "no_path"));
  assert(noPath.status === "NO_PATH", "disconnected path did not return NO_PATH"); pass("AC-P010", "disconnected_no_path");

  const pair = output(await execute("network.path.shortest", pathInput(fixture.baselineSnapshot, state(fixture.arc.p, 0), state(fixture.arc.s, 1_000_000), "SHORTEST_DISTANCE"), "pairwise"));
  const pairKeys = (pair.segments as Row[]).map((segment) => segment.arcKey);
  assert(!pairKeys.includes(fixture.arc.q) && pairKeys.includes(fixture.arc.r), "pairwise forbidden turn was used"); pass("AC-P011", "pairwise_forbidden_avoided");
  const penalty = output(await execute("network.path.shortest", pathInput(fixture.baselineSnapshot, state(fixture.arc.u, 0), state(fixture.arc.w, 1_000_000), "WEIGHTED"), "penalty"));
  assert((penalty.segments as Row[]).reduce((sum, segment) => sum + Number(segment.turnPenaltyUnits ?? 0), 0) === 17, "pairwise penalty was not charged exactly once"); pass("AC-P012", "pairwise_penalty_once");
  const sequence = output(await execute("network.path.shortest", pathInput(fixture.baselineSnapshot, state(fixture.arc.a, 0), state(fixture.arc.f, 1_000_000), "SHORTEST_DISTANCE"), "sequence"));
  const sequenceKeys = (sequence.segments as Row[]).map((segment) => segment.arcKey);
  assert(!(sequenceKeys.includes(fixture.arc.a) && sequenceKeys.includes(fixture.arc.b) && sequenceKeys.includes(fixture.arc.e)), "forbidden multi-edge sequence was used"); pass("AC-P013", "multi_edge_sequence_avoided");
  assert(sequenceKeys[0] === fixture.arc.a && sequenceKeys.at(-1) === fixture.arc.f, "product state lost across the routed intermediate nodes"); pass("AC-P014", "product_state_continuity");
  const conditioned = output(await execute("network.path.shortest", pathInput(fixture.changedSnapshot, state(fixture.arc.a, 0), state(fixture.arc.f, 1_000_000), "SHORTEST_DISTANCE"), "condition"));
  assert(!(conditioned.segments as Row[]).some((segment) => segment.arcKey === fixture.arc.c), "closed arc was used"); pass("AC-P015", "condition_closure_avoided");

  const expanded = output(await execute("network.path.expand", ordinary, "expand"));
  assert((expanded.segments as Row[]).length === (ordinary.segments as Row[]).length, "expanded path lost segments"); pass("AC-P016", "authoritative_arc_fraction_expansion");
  const continuityMutation = structuredClone(ordinary); (continuityMutation.segments as Row[])[1]!.startFractionPpm = 500_000; continuityMutation.resultHash = sha256(withoutHash(continuityMutation));
  const continuityReport = output(await execute("network.path.verify", continuityMutation, "verify_continuity"));
  assert(continuityReport.status === "INVALID", "independent verifier accepted continuity mutation"); pass("AC-P017", "continuity_mutation_caught");
  const turnMutation = structuredClone(pair); (turnMutation.segments as Row[])[1]!.arcKey = fixture.arc.q; turnMutation.resultHash = sha256(withoutHash(turnMutation));
  const turnReport = output(await execute("network.path.verify", turnMutation, "verify_turn"));
  assert(turnReport.status === "INVALID", "independent verifier accepted turn mutation"); pass("AC-P018", "turn_mutation_caught");
  await expectCode(() => execute("network.path.shortest", { ...pathInput(fixture.baselineSnapshot, state(fixture.arc.t1, 0), state(fixture.arc.t2, 1_000_000), "SHORTEST_DISTANCE"), maximumSegments: 1 }, "segment_budget"), "BUDGET_EXCEEDED");
  await expectCode(() => execute("network.path.shortest", pathInput(fixture.baselineSnapshot, state(fixture.arc.t1, 0), state(fixture.arc.t2, 1_000_000), "SHORTEST_DISTANCE"), "deadline", -1), "DEADLINE_EXCEEDED"); pass("AC-P019", "deadline_and_segment_budget_fail_closed");

  const beforeRestart = output(await execute("network.path.shortest", pathInput(fixture.baselineSnapshot, state(fixture.arc.t1, 0), state(fixture.arc.t2, 1_000_000), "SHORTEST_DISTANCE"), "before_restart"));
  assert(beforeRestart.status === "COMPLETED", "pre-restart provider call failed");
  await builderPool.end(); builderPool = undefined;
  docker(["compose", "restart", "postgres"]);
  await waitHealthy(containerId);
  const afterRestart = output(await execute("network.path.shortest", pathInput(fixture.baselineSnapshot, state(fixture.arc.t1, 0), state(fixture.arc.t2, 1_000_000), "SHORTEST_DISTANCE"), "after_restart"));
  assert(afterRestart.resultHash === beforeRestart.resultHash, "provider did not reconnect reproducibly after database restart"); pass("AC-P020", "same_provider_pool_reconnected_after_db_restart");

  evidence.summary = { graphVersionId: fixture.graphVersionId, graphVersion: fixture.baselineSnapshot.graphVersion, arcCount: Object.keys(fixture.arc).length, turnRuleCount: 3, pgrDistance, providerResultHashBeforeRestart: beforeRestart.resultHash, providerResultHashAfterRestart: afterRestart.resultHash, acceptancePassed: Object.keys(evidence.acceptance).length };
  evidence.status = "PASS";
  await providerPool.end(); providerPool = undefined;
  docker(["rm", "--force", proxyName]); proxyCreated = false;
  docker(["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", "postgres", "--set", "ON_ERROR_STOP=on", "--command", `DROP ROLE ${builderRole}; DROP ROLE ${providerRole}`]); rolesCreated = false;
  await persist(); process.stdout.write(`GOWM_NETWORK_PROVIDER_RUNTIME_PASS ${runId} ${database}\n`);
} catch (error) {
  evidence.status = "FAIL"; evidence.errors.push(String(error instanceof Error ? error.stack ?? error.message : error)); await persist(); throw error;
} finally {
  await builderPool?.end().catch(() => undefined); await providerPool?.end().catch(() => undefined);
  if (proxyCreated) try { docker(["rm", "--force", proxyName]); } catch { /* retain primary result */ }
  if (rolesCreated) try { docker(["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", "postgres", "--set", "ON_ERROR_STOP=on", "--command", `DROP ROLE IF EXISTS ${builderRole}; DROP ROLE IF EXISTS ${providerRole}`]); } catch { /* retain primary result */ }
}

async function seedFixture(pool: Pool): Promise<{ dataScopeKey: string; datasetScopeKey: string; graphVersionId: string; profileIds: { travel: string; cost: string }; conditionIds: { baseline: string; changed: string }; baselineSnapshot: Row; changedSnapshot: Row; arc: Record<FeatureName, string> }> {
  const build: MaterializedNetworkBuild = { adapterKind: "CATALOG_VECTOR_LAYER", dataset: { datasetReferenceKey: featureId("dataset"), datasetVersion: "1", datasetKind: "NETWORK", contentHash: digest("dataset"), dataScopeKey: "runtime-context", datasetScopeKey: "n01-acceptance" }, buildPolicy: { version: `p01-policy-${runId}`, coordinatePrecisionNanodegrees: 1, defaultElevationMm: 0, connectAtGradeIntersections: true }, features: fixtureFeatures(), sourceContentHash: sha256({ runId, fixture: "p01-source" }), graphIdentityHash: sha256({ runId, fixture: "p01-graph" }), warnings: [] };
  const topology = buildNetworkTopology(build);
  const byFeature = (name: string) => { const id = featureId(name); const edge = topology.edges.find((candidate) => candidate.sourceFeatureReferenceKey === id); const candidate = edge && topology.arcs.find((arc) => arc.edgeKey === edge.edgeKey); if (!candidate) throw new Error(`fixture arc ${name} unavailable`); return candidate; };
  const compiled = compileTurnRestrictions({ topology, pairwise: [
    { restrictionReferenceKey: featureId("restriction-pair"), fromFeatureReferenceKey: featureId("p"), viaNodeKey: byFeature("p").targetNodeKey, toFeatureReferenceKey: featureId("q"), ruleType: "FORBIDDEN" },
    { restrictionReferenceKey: featureId("restriction-penalty"), fromFeatureReferenceKey: featureId("u"), viaNodeKey: byFeature("u").targetNodeKey, toFeatureReferenceKey: featureId("v"), ruleType: "PENALTY", penaltyUnits: 17 }
  ], sequences: [{ restrictionReferenceKey: featureId("restriction-sequence"), featureReferenceKeys: [featureId("a"), featureId("b"), featureId("e")], ruleType: "FORBIDDEN" }] });
  if (compiled.diagnostics.length) throw new Error(`turn fixture diagnostics: ${JSON.stringify(compiled.diagnostics)}`);
  const profile = createTravelProfile({ profileKey: `p01-road-${runId}`, version: "1", vehicleClass: "ROAD_VEHICLE", allowedRoadClasses: ["PRIMARY"], allowedSurfaces: ["ASPHALT"], onewayPolicy: "STRICT", maximumSpeedMmPerS: 20_000, requiredAccessMask: 0 });
  const cost = createCostProfile({ profileKey: `p01-cost-${runId}`, version: "1", weights: { distance: 1_000_000, time: 0, risk: 0, energy: 0, surface: 0 } });
  const baseline = createConditionSnapshot({ sourceSnapshotVersion: "baseline", observedAt: "2026-08-25T00:00:00Z", validUntil: "2030-08-25T00:00:00Z", completeness: "COMPLETE", sourceContentHash: sha256({ runId, condition: "baseline" }), conditions: [], metadata: { runId } });
  const closedArc = byFeature("c");
  const changed = createConditionSnapshot({ sourceSnapshotVersion: "changed", observedAt: "2026-08-25T00:01:00Z", validUntil: "2030-08-25T00:01:00Z", completeness: "COMPLETE", sourceContentHash: sha256({ runId, condition: "changed" }), conditions: [{ arcKey: closedArc.arcKey, traversalAllowed: false, reasonCodes: ["P01_CLOSURE"], evidence: [{ authority: "runtime-gate" }] }], metadata: { runId } });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const contextResult = await client.query<{ graph_id: string; dataset_id: string; dataset_version_id: string; data_scope_key: string; dataset_scope_key: string }>(`SELECT graph.graph_id::text,graph.dataset_id::text,version.dataset_version_id::text,graph.data_scope_key,graph.dataset_scope_key FROM network_graph graph JOIN network_graph_version version USING (graph_id,dataset_id,data_scope_key,dataset_scope_key) WHERE graph.graph_key='n01-graph' ORDER BY version.created_at LIMIT 1`);
    const context = contextResult.rows[0]; if (!context) throw new Error("P01 base graph context unavailable");
    const versionResult = await client.query<{ graph_version_id: string }>(`INSERT INTO network_graph_version(graph_id,dataset_id,dataset_version_id,data_scope_key,dataset_scope_key,graph_version,build_policy_version,source_content_hash,topology_hash,content_hash,node_count,edge_count,arc_count,turn_rule_count,status,build_receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'VALIDATED',$15::jsonb) RETURNING graph_version_id::text`, [context.graph_id, context.dataset_id, context.dataset_version_id, context.data_scope_key, context.dataset_scope_key, runId, build.buildPolicy.version, build.sourceContentHash, topology.topologyHash, topology.contentHash, topology.nodes.length, topology.edges.length, topology.arcs.length, compiled.pairwiseRules.length + compiled.sequenceRules.length, JSON.stringify({ runId, phase: "P01" })]);
    const graphVersionId = versionResult.rows[0]?.graph_version_id; if (!graphVersionId) throw new Error("P01 graph version missing");
    const rows = await new PostgresNetworkTopologyWriter(client).persist({ graphVersionId, dataScopeKey: context.data_scope_key, topology });
    await new PostgresNetworkTurnWriter(client).persist({ graphVersionId, dataScopeKey: context.data_scope_key, compiled, nodeIdsByKey: rows.nodeIdsByKey, arcIdsByKey: rows.arcIdsByKey });
    const metrics = new Map(topology.arcs.map((arc) => [arc.arcKey, { riskMicroUnits: 1, energyMwh: 1, surfacePenaltyUnits: 0 }]));
    const writer = new PostgresNetworkProfileConditionWriter(client);
    const persisted = await writer.persistProfile({ graphVersionId, dataScopeKey: context.data_scope_key, topology, arcIdsByKey: rows.arcIdsByKey, travelProfile: profile, costProfile: cost, baseMetricsByArcKey: metrics });
    const baselineId = await writer.persistConditionSnapshot({ graphVersionId, dataScopeKey: context.data_scope_key, arcIdsByKey: rows.arcIdsByKey, snapshot: baseline });
    const changedId = await writer.persistConditionSnapshot({ graphVersionId, dataScopeKey: context.data_scope_key, arcIdsByKey: rows.arcIdsByKey, snapshot: changed });
    await client.query(`INSERT INTO network_build_run(graph_id,dataset_version_id,data_scope_key,dataset_scope_key,build_policy_version,adapter_kind,status,input_hash,output_hash,requested_at,started_at,finished_at,receipt) VALUES($1,$2,$3,$4,$5,'CATALOG_VECTOR_LAYER','SUCCEEDED',$6,$7,clock_timestamp(),clock_timestamp(),clock_timestamp(),$8::jsonb)`, [context.graph_id, context.dataset_version_id, context.data_scope_key, context.dataset_scope_key, build.buildPolicy.version, build.sourceContentHash, topology.contentHash, JSON.stringify({ runId, phase: "P01" })]);
    await client.query("COMMIT");
    const arc = Object.fromEntries(FEATURE_NAMES.map((name) => [name, externalArcKey(byFeature(name).arcKey)])) as Record<FeatureName, string>;
    const baseSnapshot = { networkDatasetVersion: "1", graphVersion: runId, travelProfileVersion: profile.version, costProfileVersion: cost.version, graphContentHash: topology.contentHash, costContentHash: cost.contentHash };
    return { dataScopeKey: context.data_scope_key, datasetScopeKey: context.dataset_scope_key, graphVersionId, profileIds: { travel: persisted.travelProfileVersionId, cost: persisted.costProfileVersionId }, conditionIds: { baseline: baselineId, changed: changedId }, baselineSnapshot: { ...baseSnapshot, conditionSnapshotId: baselineId, conditionContentHash: baseline.contentHash }, changedSnapshot: { ...baseSnapshot, conditionSnapshotId: changedId, conditionContentHash: changed.contentHash }, arc };
  } catch (error) { try { await client.query("ROLLBACK"); } catch { /* closed */ } throw error; } finally { client.release(); }
}

function fixtureFeatures(): MaterializedNetworkFeature[] {
  const feature = (name: string, points: Array<[number, number]>, roadClass = "PRIMARY"): MaterializedNetworkFeature => ({ featureReferenceKey: featureId(name), featureVersion: "1", layerKey: "p01-road-centerline", contentHash: digest(name), positions: points.map(([longitude, latitude]) => ({ longitudeNanodegrees: Math.round(longitude * 1_000_000_000), latitudeNanodegrees: Math.round(latitude * 1_000_000_000), elevationMm: 0 })), properties: { roadClass, surface: "ASPHALT", oneway: true, defaultSpeedMmPerS: 20_000 } });
  return [
    feature("p", [[0, 0], [0.001, 0]]), feature("q", [[0.001, 0], [0.002, 0]]), feature("r", [[0.001, 0], [0.0015, 0.0005], [0.002, 0]]), feature("s", [[0.002, 0], [0.003, 0]]),
    feature("a", [[0, 0.005], [0.001, 0.005]]), feature("b", [[0.001, 0.005], [0.002, 0.005]]), feature("c", [[0.001, 0.005], [0.0015, 0.0054], [0.002, 0.005]]), feature("d", [[0.001, 0.005], [0.0015, 0.006], [0.002, 0.005]]), feature("e", [[0.002, 0.005], [0.003, 0.005]]), feature("f", [[0.003, 0.005], [0.004, 0.005]]),
    feature("u", [[0, 0.01], [0.001, 0.01]]), feature("v", [[0.001, 0.01], [0.002, 0.01]]), feature("w", [[0.002, 0.01], [0.003, 0.01]]),
    feature("t1", [[0, 0.02], [0.001, 0.02]]), feature("t2", [[0.001, 0.02], [0.002, 0.02]]), feature("x", [[0.01, 0.03], [0.011, 0.03]]),
    feature("ambEast", [[0.05, 0.015], [0.051, 0.015]]), feature("ambWest", [[0.051, 0.015], [0.05, 0.015]]),
    feature("illegalTrack", [[0.06, 0.025], [0.061, 0.025]], "TRACK"), feature("legalParallel", [[0.06, 0.0251], [0.061, 0.0251]])
  ];
}

async function pgrDifferential(pool: Pool, graphVersionId: string, travelId: string, costId: string, _conditionId: string, startKey: string, endKey: string): Promise<number> {
  void pool;
  for (const value of [graphVersionId, travelId, costId]) if (!/^[0-9a-f-]{36}$/u.test(value)) throw new Error("invalid pgRouting fixture UUID");
  const start = internalArcKey(startKey); const end = internalArcKey(endKey);
  const sql = `WITH endpoints AS (SELECT max(CASE WHEN arc_key='${start}' THEN source_node_id END) AS source,max(CASE WHEN arc_key='${end}' THEN target_node_id END) AS target FROM network_arc WHERE graph_version_id='${graphVersionId}'::uuid), route AS (SELECT * FROM pgr_dijkstra('SELECT arc.arc_id AS id,arc.source_node_id AS source,arc.target_node_id AS target,cost.distance_mm::float8 AS cost,-1::float8 AS reverse_cost FROM network_arc arc JOIN network_arc_cost cost USING(graph_version_id,arc_id,data_scope_key) WHERE arc.graph_version_id=''${graphVersionId}''::uuid AND cost.travel_profile_version_id=''${travelId}''::uuid AND cost.cost_profile_version_id=''${costId}''::uuid',(SELECT source FROM endpoints),(SELECT target FROM endpoints),true)) SELECT COALESCE(sum(cost),0)::bigint::text FROM route WHERE edge<>-1`;
  const result = docker(["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", database, "--set", "ON_ERROR_STOP=on", "--tuples-only", "--no-align", "--command", sql], ["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", database, "<fixed pgr_dijkstra differential query>"]);
  return Number(result.trim());
}
async function waitHealthy(containerId: string): Promise<void> { for (let attempt = 0; attempt < 60; attempt += 1) { try { if (docker(["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", containerId]) === "healthy") return; } catch { /* retry */ } await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)); } throw new Error("PostgreSQL did not become healthy after restart"); }
function snapInput(routingSnapshot: Row, location: Row, maxDistanceM: number, limit: number): Row { return { routingSnapshot, location, maxDistanceM, limit }; }
function pathInput(routingSnapshot: Row, start: Row, destination: Row, objective: string): Row { return { routingSnapshot, start, destination, objective, turnLegality: "STRICT", maximumSegments: 100, deadlineMs: 30_000 }; }
function state(arcKey: string, fractionPpm: number): Row { return { arcKey, fractionPpm, direction: "FORWARD" }; }
function output(envelope: { output?: { value: unknown } }): Row { const value = envelope.output?.value; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider output unavailable"); return value as Row; }
function withoutHash(value: Row): Row { const { resultHash: _ignored, ...rest } = value; return rest; }
function pass(id: string, detail: string): void { evidence.acceptance[id] = `PASS_${detail.toUpperCase()}`; }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> { try { await action(); } catch (error) { if (error instanceof ProviderProtocolError && error.code === code) return; throw error; } throw new Error(`expected ${code}`); }
function requiredEnv(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function secret(label: string): string { return createHash("sha256").update(`${composeProject}:${runId}:${label}`).digest("hex"); }
function featureId(label: string): string { return `wrf_${createHash("sha256").update(`p01:${label}`).digest("hex").slice(0, 32)}`; }
function digest(label: string): `sha256:${string}` { return `sha256:${createHash("sha256").update(`p01-content:${label}`).digest("hex")}`; }
function externalArcKey(value: string): string { return `arc_${value.slice(3)}`; }
function internalArcKey(value: string): string { return `ar_${value.slice(4)}`; }
