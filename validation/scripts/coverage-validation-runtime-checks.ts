import type { Pool } from "pg";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";

/** Seed facts in the isolated PostgreSQL authority; never replace its methods. */
export async function seedPlatformValidationCases(admin: Pool, routingSnapshot: Record<string, unknown>, dataScope: string, datasetScope: string) {
  const statuses = ["SUCCEEDED", "PARTIAL", "NO_DATA", "AMBIGUOUS", "INDETERMINATE", "NO_PATH", "STALE", "FAILED", "COMPLETED", "COMPLETED", "COMPLETED"];
  const keys = [];
  for (const [index, sourceStatus] of statuses.entries()) {
    const ordinal = String(index + 1).padStart(2, "0");
    const referenceKey = { namespace: "gowm" as const, kind: "QUERY_RESULT", id: `wrf_700000000000000000000000000000${ordinal}`, version: "1" };
    keys.push(referenceKey);
    const queryId = `validation-source-${ordinal}`;
    const job = (await admin.query(`INSERT INTO gowm_capability.gateway_job(job_kind,principal_hash,data_scope_key,request_hash,state,completed_at)
      VALUES ('WORLD_QUERY',$1,$2,$3,'SUCCEEDED',clock_timestamp()) RETURNING job_id`, [sha256(queryId), dataScope, sha256({ queryId })])).rows[0];
    const requestId = `request-${queryId}`, idempotencyKey = `idempotency-${queryId}`, schemaHash = sha256({ schema: "validation-seeded-record" });
    await admin.query(`INSERT INTO gowm_capability.world_query_job(query_id,job_id,public_job_id,request_id,principal_ref,principal_hash,
      idempotency_key,request_hash,parameter_schema_hash,plan_hash,submission,authentication_method,authenticated_at,data_scope_claim,dataset_scope_claim)
      VALUES ($1,$2,$3,$4,'principal:postgres-validation-seed',$5,$6,$7,$8,$9,$10,'POSTGRES_TEST_SEED',clock_timestamp(),$11,$12)`,
    [queryId, job.job_id, `job-${queryId}`, requestId, sha256(queryId), idempotencyKey, sha256({ queryId }), schemaHash, sha256({ plan: queryId }),
      JSON.stringify({ requestId, idempotencyKey, parameterSchemaHash: schemaHash, plan: { queryId } }), dataScope, index === 10 ? "tenant-other" : datasetScope]);
    await admin.query("SELECT register_result_registry_identity($1,'QUERY_RESULT',$2,$3,$4)", [referenceKey.id, queryId, dataScope, `PostgreSQL source status ${sourceStatus}`]);
    const result = { status: sourceStatus, ...(index === 9 ? {} : { routingSnapshot }) };
    const normalized = sourceStatus === "SUCCEEDED" ? "COMPLETED" : sourceStatus === "NO_PATH" ? "NO_FEASIBLE_RESULT" : sourceStatus;
    await admin.query(`INSERT INTO world_query_result_reference(reference_key,query_id,data_scope_key,result_hash,status,data_snapshot_hash,compute_snapshot_hash,result_record,valid_until)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '1 hour')`,
    [referenceKey.id, queryId, dataScope, sha256(result), normalized, sha256(routingSnapshot), sha256({ seed: "PostgreSQL semantic cases" }), JSON.stringify(result)]);
    if (sourceStatus === "STALE") await admin.query(`INSERT INTO world_reference_descriptor_version(reference_key,data_scope_key,reference_type,display_name,stale,revalidation_required,content_hash)
      VALUES ($1,$2,'QUERY_RESULT','PostgreSQL stale descriptor',true,true,$3)`, [referenceKey.id, dataScope, sha256({ id: referenceKey.id, stale: true })]);
    if (index === 8) await admin.query("INSERT INTO world_reference_retirement(reference_key,reason,receipt_ref) VALUES ($1,'Retired in authoritative lifecycle','urn:gowm:g00:retirement')", [referenceKey.id]);
  }
  const derived = (await admin.query(`SELECT create_derived_reference($1,'ANALYSIS_RESULT','test.analysis','validation-source-01','node',ARRAY[$2]::text[],
    $3,$4,'1.0',NULL,NULL,clock_timestamp()+interval '1 hour',true) AS id`, [dataScope, keys[0]!.id, sha256(routingSnapshot), sha256({ seed: "derived" })])).rows[0].id as string;
  const set = (await admin.query("SELECT create_reference_set($1,'VALIDATION_TEST','validation-source-01',ARRAY[$2]::text[],clock_timestamp()+interval '1 hour') AS id", [dataScope, keys[0]!.id])).rows[0].id as string;
  await admin.query("INSERT INTO world_object(id,object_type,data_scope_key) VALUES ('g00-validation-world','VALIDATION_TEST',$1)", [dataScope]);
  await admin.query("INSERT INTO world_object_state(object_id,version) VALUES ('g00-validation-world',2)");
  const worldId = (await admin.query("SELECT reference_key FROM world_reference_identity WHERE entity_kind='WORLD_OBJECT' AND internal_id='g00-validation-world' AND data_scope_key=$1", [dataScope])).rows[0].reference_key as string;
  return { keys, derived: { ...keys[0]!, id: derived, kind: "DERIVED_REFERENCE" }, set: { ...keys[0]!, id: set, kind: "REFERENCE_SET" }, world: { namespace: "gowm" as const, kind: "WORLD_OBJECT", id: worldId, version: "2" } };
}

export async function withAdvancedGraph<T>(admin: Pool, dataScope: string, run: () => Promise<T>): Promise<T> {
  const actor = (await admin.query("SELECT reference_key FROM world_reference_identity WHERE entity_kind='WORLD_OBJECT' AND internal_id='g00-validation-world' AND data_scope_key=$1", [dataScope])).rows[0].reference_key;
  const old = (await admin.query("SELECT graph_version_id FROM network_graph_version WHERE data_scope_key=$1 AND graph_version='graph-v1'", [dataScope])).rows[0].graph_version_id;
  const existing = (await admin.query("SELECT graph_version_id FROM network_graph_version WHERE data_scope_key=$1 AND graph_version='graph-v2-empty'", [dataScope])).rows[0];
  const next = existing?.graph_version_id ?? (await admin.query(`INSERT INTO network_graph_version(graph_id,dataset_id,dataset_version_id,data_scope_key,dataset_scope_key,
    graph_version,build_policy_version,source_content_hash,topology_hash,content_hash,node_count,edge_count,arc_count,turn_rule_count,status)
    SELECT graph_id,dataset_id,dataset_version_id,data_scope_key,dataset_scope_key,'graph-v2-empty','g00-empty-graph/2',
      $2,$3,$4,0,0,0,0,'VALIDATED' FROM network_graph_version WHERE graph_version_id=$1 RETURNING graph_version_id`,
  [old, sha256({ source: "empty" }), sha256({ topology: "empty" }), sha256({ graph: "v2-empty" })])).rows[0].graph_version_id;
  await admin.query("SELECT activate_network_graph_version($1,'g00-currentness/1',$2)", [next, actor]);
  // Activation history is immutable and a retired version cannot be reactivated.
  // This destructive-to-the-fixture scenario must run last in the disposable database.
  return run();
}
