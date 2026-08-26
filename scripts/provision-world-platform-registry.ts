import { Pool } from "pg";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadControlledProviderDeployments, type ControlledProviderDeployment } from "../services/gateway/world-capability-gateway/src/config.js";

/** Explicit administrator bootstrap, never executed by the Gateway request path. */
export async function persistControlledRegistry(pool: Pool, deployments: readonly ControlledProviderDeployment[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const deployment of deployments) {
      const m = deployment.approvedManifest, endpoint = deployment.endpoint.origin;
      await client.query(`INSERT INTO gowm_capability.provider_registry
        (provider_id,provider_version,display_name,owner_name,endpoint,manifest_uri,endpoint_bindings,manifest_hash,implementation_digest,source_ref,approval_state,approved_by,approved_at,enabled)
        VALUES ($1,$2,$1,$3,$4,$5,$6::jsonb,$7,$8,$9,'APPROVED',$10,clock_timestamp(),true)
        ON CONFLICT (provider_id) DO UPDATE SET provider_version=EXCLUDED.provider_version,endpoint=EXCLUDED.endpoint,manifest_uri=EXCLUDED.manifest_uri,endpoint_bindings=EXCLUDED.endpoint_bindings,manifest_hash=EXCLUDED.manifest_hash,implementation_digest=EXCLUDED.implementation_digest,approval_state=EXCLUDED.approval_state,approved_by=EXCLUDED.approved_by,approved_at=EXCLUDED.approved_at,enabled=true`,
        [m.provider.providerId,m.provider.providerVersion,m.provider.owner,endpoint,`${endpoint}/v1/manifest`,JSON.stringify(m.endpoints),deployment.manifestHash,m.provider.implementationDigest,m.provider.sourceRef ?? null,deployment.approvedBy]);
      for (const c of m.capabilities) {
        await client.query(`INSERT INTO gowm_capability.capability(operation_id,semantic_role,data_binding,result_semantics,description)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (operation_id) DO NOTHING`,[c.operationId,c.semanticRole,c.dataBinding,c.resultSemantics,`${c.operationId} controlled world-platform operation`]);
        const saved = await client.query(`INSERT INTO gowm_capability.provider_operation
          (operation_id,operation_version,provider_id,input_schema_uri,input_schema_hash,output_schema_uri,output_schema_hash,maturity,scope_policy,execution_mode,execution_bindings,critical_path_policy,default_timeout_ms,maximum_timeout_ms,cost_class,limits,ports,data_snapshot_policy,compute_snapshot_policy,policy_version,enabled)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19,$20,true)
          ON CONFLICT (operation_id,operation_version) DO UPDATE SET input_schema_uri=EXCLUDED.input_schema_uri,input_schema_hash=EXCLUDED.input_schema_hash,output_schema_uri=EXCLUDED.output_schema_uri,output_schema_hash=EXCLUDED.output_schema_hash,maturity=EXCLUDED.maturity,scope_policy=EXCLUDED.scope_policy,execution_mode=EXCLUDED.execution_mode,execution_bindings=EXCLUDED.execution_bindings,critical_path_policy=EXCLUDED.critical_path_policy,default_timeout_ms=EXCLUDED.default_timeout_ms,maximum_timeout_ms=EXCLUDED.maximum_timeout_ms,cost_class=EXCLUDED.cost_class,limits=EXCLUDED.limits,ports=EXCLUDED.ports,data_snapshot_policy=EXCLUDED.data_snapshot_policy,compute_snapshot_policy=EXCLUDED.compute_snapshot_policy,policy_version=EXCLUDED.policy_version,enabled=true
          WHERE gowm_capability.provider_operation.provider_id=EXCLUDED.provider_id`,
          [c.operationId,c.operationVersion,m.provider.providerId,c.inputSchemaUri,c.inputSchemaHash,c.outputSchemaUri,c.outputSchemaHash,c.maturity,c.scopePolicy,c.execution.mode,c.executionBindings,c.criticalPathPolicy,c.execution.defaultTimeoutMs,c.execution.maximumTimeoutMs,c.execution.costClass,JSON.stringify(c.limits),JSON.stringify(c.ports),c.snapshotPolicy.dataSnapshot,c.snapshotPolicy.computeSnapshot,"world-platform/0.6.2"]);
        if (saved.rowCount !== 1) throw new Error(`Persistent operation ownership collision: ${c.operationId}@${c.operationVersion}`);
      }
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.GATEWAY_REGISTRY_DATABASE_URL) throw new Error("GATEWAY_REGISTRY_DATABASE_URL is required for explicit bootstrap");
  const pool = new Pool({ connectionString: process.env.GATEWAY_REGISTRY_DATABASE_URL, max:1 });
  try { await persistControlledRegistry(pool, await loadControlledProviderDeployments(resolve(process.env.GATEWAY_PROVIDER_REGISTRY_PATH ?? "config/world-platform-gateway-registry.json"))); }
  finally { await pool.end(); }
}
