import type pg from "pg";
import type { CapabilityProviderManifest } from "../../../../packages/platform/contract-runtime/src/index.js";
import { sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { ControlledProviderDeployment } from "./config.js";
import { controlledProviderUrl } from "./http-provider-client.js";

export interface ApprovedProviderDeployment {
  config: ControlledProviderDeployment;
  manifest: CapabilityProviderManifest;
}

/**
 * Reconciles only the explicitly approved, hash-locked startup set. This is a
 * registry-admin bootstrap operation, not dynamic provider discovery.
 */
export async function synchronizePostgresRegistry(
  pool: pg.Pool,
  providers: readonly ApprovedProviderDeployment[]
): Promise<void> {
  if (providers.length === 0) throw new Error("controlled provider registry cannot be empty");
  for (const { config, manifest } of providers) assertDeploymentLock(config, manifest);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE gowm_capability.provider_operation SET enabled=false, updated_at=clock_timestamp()
       WHERE enabled=true`
    );
    await client.query(
      `UPDATE gowm_capability.provider_registry SET enabled=false, updated_at=clock_timestamp()
       WHERE enabled=true`
    );
    for (const provider of providers) await upsertProvider(client, provider);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function assertDeploymentLock(config: ControlledProviderDeployment, manifest: CapabilityProviderManifest): void {
  if (
    manifest.provider.providerId !== config.providerId ||
    manifest.provider.providerVersion !== config.providerVersion ||
    manifest.provider.implementationDigest !== config.implementationDigest ||
    sha256(manifest) !== config.manifestHash
  ) {
    throw new Error(`provider ${config.providerId} differs from the approved deployment lock`);
  }
}

async function upsertProvider(client: pg.PoolClient, provider: ApprovedProviderDeployment): Promise<void> {
  const { config, manifest } = provider;
  await client.query(
    `INSERT INTO gowm_capability.provider_registry (
       provider_id, provider_version, display_name, owner_name, protocol_version,
       endpoint, manifest_uri, endpoint_bindings, manifest_hash, implementation_digest,
       source_ref, source_git_commit, approval_state, approved_by, approved_at, enabled
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,'APPROVED',$13,clock_timestamp(),true)
     ON CONFLICT (provider_id) DO UPDATE SET
       provider_version=EXCLUDED.provider_version,
       display_name=EXCLUDED.display_name,
       owner_name=EXCLUDED.owner_name,
       protocol_version=EXCLUDED.protocol_version,
       endpoint=EXCLUDED.endpoint,
       manifest_uri=EXCLUDED.manifest_uri,
       endpoint_bindings=EXCLUDED.endpoint_bindings,
       manifest_hash=EXCLUDED.manifest_hash,
       implementation_digest=EXCLUDED.implementation_digest,
       source_ref=EXCLUDED.source_ref,
       source_git_commit=EXCLUDED.source_git_commit,
       approval_state='APPROVED',
       approved_by=EXCLUDED.approved_by,
       approved_at=clock_timestamp(),
       enabled=true,
       updated_at=clock_timestamp()`,
    [
      config.providerId,
      config.providerVersion,
      config.providerId,
      manifest.provider.owner,
      manifest.providerProtocolVersion,
      config.endpoint.toString(),
      controlledProviderUrl(config.endpoint, manifest.endpoints.manifest).toString(),
      JSON.stringify(manifest.endpoints),
      config.manifestHash,
      config.implementationDigest,
      manifest.provider.sourceRef ?? null,
      manifest.provider.sourceGitCommit ?? null,
      config.approvedBy
    ]
  );

  for (const descriptor of manifest.capabilities) {
    await client.query(
      `INSERT INTO gowm_capability.capability (
         operation_id, semantic_role, data_binding, result_semantics, description
       ) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (operation_id) DO UPDATE SET
         semantic_role=EXCLUDED.semantic_role,
         data_binding=EXCLUDED.data_binding,
         result_semantics=EXCLUDED.result_semantics,
         description=EXCLUDED.description`,
      [
        descriptor.operationId,
        descriptor.semanticRole,
        descriptor.dataBinding,
        descriptor.resultSemantics,
        `Approved capability ${descriptor.operationId}`
      ]
    );
    await client.query(
      `INSERT INTO gowm_capability.provider_operation (
         operation_id, operation_version, provider_id,
         input_schema_uri, input_schema_hash, output_schema_uri, output_schema_hash,
         maturity, scope_policy, execution_mode, execution_bindings, critical_path_policy,
         default_timeout_ms, maximum_timeout_ms, cost_class, limits, ports, deprecation,
         data_snapshot_policy, compute_snapshot_policy, policy_version, enabled
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12,$13,$14,$15,$16::jsonb,$17::jsonb,
         $18::jsonb,$19,$20,$21,true
       )
       ON CONFLICT (operation_id, operation_version) DO UPDATE SET
         provider_id=EXCLUDED.provider_id,
         input_schema_uri=EXCLUDED.input_schema_uri,
         input_schema_hash=EXCLUDED.input_schema_hash,
         output_schema_uri=EXCLUDED.output_schema_uri,
         output_schema_hash=EXCLUDED.output_schema_hash,
         maturity=EXCLUDED.maturity,
         scope_policy=EXCLUDED.scope_policy,
         execution_mode=EXCLUDED.execution_mode,
         execution_bindings=EXCLUDED.execution_bindings,
         critical_path_policy=EXCLUDED.critical_path_policy,
         default_timeout_ms=EXCLUDED.default_timeout_ms,
         maximum_timeout_ms=EXCLUDED.maximum_timeout_ms,
         cost_class=EXCLUDED.cost_class,
         limits=EXCLUDED.limits,
         ports=EXCLUDED.ports,
         deprecation=EXCLUDED.deprecation,
         data_snapshot_policy=EXCLUDED.data_snapshot_policy,
         compute_snapshot_policy=EXCLUDED.compute_snapshot_policy,
         policy_version=EXCLUDED.policy_version,
         enabled=true,
         updated_at=clock_timestamp()`,
      [
        descriptor.operationId,
        descriptor.operationVersion,
        config.providerId,
        descriptor.inputSchemaUri,
        descriptor.inputSchemaHash,
        descriptor.outputSchemaUri,
        descriptor.outputSchemaHash,
        descriptor.maturity,
        descriptor.scopePolicy,
        descriptor.execution.mode,
        descriptor.executionBindings,
        descriptor.criticalPathPolicy,
        descriptor.execution.defaultTimeoutMs,
        descriptor.execution.maximumTimeoutMs,
        descriptor.execution.costClass,
        JSON.stringify(descriptor.limits),
        JSON.stringify(descriptor.ports),
        descriptor.deprecation === undefined ? null : JSON.stringify(descriptor.deprecation),
        descriptor.snapshotPolicy.dataSnapshot,
        descriptor.snapshotPolicy.computeSnapshot,
        `manifest:${config.manifestHash}`
      ]
    );
  }
}
