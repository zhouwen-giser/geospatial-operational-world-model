import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  CapabilityDescriptor,
  CapabilityProviderManifest,
  WorldQuerySubmission
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  getContractSchema,
  getContractSchemaHash
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  createProviderRuntime,
  sha256,
  type ProviderOperation
} from "../../packages/platform/provider-sdk/src/index.js";
import {
  CapabilityRegistry,
  DirectExecutionService,
  InProcessProviderClient,
  MemoryAuditSink,
  MemoryGatewayIdempotencyStore,
  MemoryGatewayRecordStore,
  PostgresQueryPlanStore,
  ProviderCircuitBreaker,
  QueryPlanValidator,
  WorldQueryRuntime,
  type GatewayPrincipal
} from "../../services/gateway/world-capability-gateway/src/index.js";

const databaseUrl = process.env.GOWM_DERIVED_SCOPE_DATABASE_URL ?? process.env.DATABASE_URL;
const enabled = process.env.RUN_GOWM_DERIVED_SCOPE_DB_INTEGRATION === "1" && databaseUrl !== undefined;
const runId = (process.env.GOWM_DERIVED_SCOPE_RUN_ID ?? randomUUID()).replaceAll("-", "").slice(0, 20);
const objectSchemaUri = "urn:gowm:v0.2:value:object";
const objectSchema = getContractSchema(objectSchemaUri);
const objectSchemaHash = getContractSchemaHash(objectSchemaUri);
const parameterSchemaHash = getContractSchemaHash("world-query-parameters.schema.json");
const internalScopeA = `derived-scope-a-${runId}`;
const internalScopeB = `derived-scope-b-${runId}`;
const mappedClaim = `gdps-claim-${runId}`;
const ambiguousClaim = `ambiguous-claim-${runId}`;
const unmappedClaim = `foreign-claim-${runId}`;
const excludedClaims = {
  expired: `expired-claim-${runId}`,
  future: `future-claim-${runId}`,
  authority: `wrong-authority-claim-${runId}`,
  kind: `wrong-kind-claim-${runId}`,
  confidence: `low-confidence-claim-${runId}`
} as const;
const operationId = `derived.scope.fixture.${runId}`;
const providerId = `derived.scope.provider.${runId}`;

let pool: Pool;
let providerCalls = 0;
let runtime: WorldQueryRuntime;
let descriptor: CapabilityDescriptor;

function fixtureDescriptor(): CapabilityDescriptor {
  return {
    operationId,
    operationVersion: "1.0",
    semanticRole: "GENERIC_ANALYSIS",
    dataBinding: "WORLD_INDEPENDENT",
    resultSemantics: "DERIVED_ANALYSIS",
    executionBindings: ["SYNC_HTTP"],
    criticalPathPolicy: "REMOTE_ONLY",
    maturity: "PREVIEW",
    inputSchemaUri: objectSchemaUri,
    inputSchemaHash: objectSchemaHash,
    outputSchemaUri: objectSchemaUri,
    outputSchemaHash: objectSchemaHash,
    scopePolicy: "REQUEST_CONTEXT",
    execution: { mode: "SYNC", defaultTimeoutMs: 30_000, maximumTimeoutMs: 120_000, costClass: "LOW" },
    limits: {
      maximumInputBytes: 65_536,
      maximumOutputBytes: 65_536,
      maximumRows: 10,
      maximumCandidates: 10,
      maximumBatchItems: 10
    },
    snapshotPolicy: { dataSnapshot: "NONE", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{
        name: "request",
        schemaUri: objectSchemaUri,
        schemaHash: objectSchemaHash,
        valueKind: "ANY",
        unitSemantics: "UNSPECIFIED"
      }],
      outputs: [{
        name: "result",
        schemaUri: objectSchemaUri,
        schemaHash: objectSchemaHash,
        valueKind: "ANY",
        unitSemantics: "UNSPECIFIED"
      }]
    }
  };
}

function principal(claim: string, suffix: string): GatewayPrincipal {
  return {
    principalRef: `principal:derived-scope:${suffix}:${runId}`,
    authenticationMethod: "TEST_ATTESTED",
    authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
    dataScopeClaim: claim,
    allowExperimental: true
  };
}

function submission(queryId: string): WorldQuerySubmission {
  const port = {
    schemaUri: objectSchemaUri,
    schemaHash: objectSchemaHash,
    valueKind: "ANY" as const,
    unitSemantics: "UNSPECIFIED" as const
  };
  return {
    requestId: `request:${queryId}`,
    idempotencyKey: `idempotency:${queryId}`,
    parameterSchemaHash,
    parameters: {},
    plan: {
      queryPlanVersion: "2.0",
      queryId,
      nodes: [{
        nodeId: "scope-result",
        operation: {
          operationId: descriptor.operationId,
          operationVersion: descriptor.operationVersion,
          inputSchemaHash: descriptor.inputSchemaHash,
          outputSchemaHash: descriptor.outputSchemaHash
        },
        inputs: {
          request: { kind: "LITERAL", port, value: { probe: "derived-result-scope" } }
        },
        failurePolicy: "FAIL_FAST",
        budget: {
          maximumRows: 1,
          maximumCandidates: 1,
          maximumOutputBytes: 8_192,
          maximumExecutionMs: 30_000
        }
      }],
      outputs: [{
        name: "answer",
        binding: {
          kind: "NODE_OUTPUT",
          nodeId: "scope-result",
          outputPort: "result",
          port
        }
      }],
      budgets: {
        maximumNodes: 1,
        maximumDepth: 1,
        maximumRows: 1,
        maximumCandidates: 1,
        maximumOutputBytes: 8_192,
        maximumExecutionMs: 30_000
      }
    }
  };
}

async function installFixture(): Promise<void> {
  await pool.query(
    `INSERT INTO public.data_scope(scope_key,operational_domain,description)
     VALUES ($1,'TEST','derived result scope A'),($2,'TEST','derived result scope B')`,
    [internalScopeA, internalScopeB]
  );
  await pool.query(
    `INSERT INTO public.world_reference_external_identifier(
       reference_key,data_scope_key,authority,identifier_kind,identifier_value,
       normalized_value,confidence,evidence
     )
     SELECT identity.reference_key,identity.data_scope_key,'GOWM_GATEWAY','DATA_SCOPE_CLAIM',
            mapping.claim,public.normalize_reference_text(mapping.claim),1,
            '[{"kind":"POSTGRES_RUNTIME_ASSERTION"}]'::jsonb
     FROM (VALUES ($1::text,$2::text),($3::text,$2::text),($3::text,$4::text)) mapping(claim,scope_key)
     JOIN public.world_reference_identity identity
       ON identity.entity_kind='DATA_SCOPE'
      AND identity.internal_id=mapping.scope_key
      AND identity.data_scope_key=mapping.scope_key`,
    [mappedClaim, internalScopeA, ambiguousClaim, internalScopeB]
  );
  await pool.query(
    `INSERT INTO public.world_reference_external_identifier(
       reference_key,data_scope_key,authority,identifier_kind,identifier_value,
       normalized_value,confidence,evidence,valid_from,valid_to
     )
     SELECT identity.reference_key,identity.data_scope_key,mapping.authority,mapping.kind,
            mapping.claim,public.normalize_reference_text(mapping.claim),mapping.confidence,
            '[{"kind":"POSTGRES_RUNTIME_ASSERTION"}]'::jsonb,mapping.valid_from,mapping.valid_to
     FROM (VALUES
       ($1::text,'GOWM_GATEWAY','DATA_SCOPE_CLAIM',1::double precision,'-infinity'::timestamptz,clock_timestamp()-interval '1 hour'),
       ($2::text,'GOWM_GATEWAY','DATA_SCOPE_CLAIM',1::double precision,clock_timestamp()+interval '1 hour','infinity'::timestamptz),
       ($3::text,'FOREIGN_AUTHORITY','DATA_SCOPE_CLAIM',1::double precision,'-infinity'::timestamptz,'infinity'::timestamptz),
       ($4::text,'GOWM_GATEWAY','FOREIGN_KIND',1::double precision,'-infinity'::timestamptz,'infinity'::timestamptz),
       ($5::text,'GOWM_GATEWAY','DATA_SCOPE_CLAIM',0.5::double precision,'-infinity'::timestamptz,'infinity'::timestamptz)
     ) mapping(claim,authority,kind,confidence,valid_from,valid_to)
     JOIN public.world_reference_identity identity
       ON identity.entity_kind='DATA_SCOPE'
      AND identity.internal_id=$6
      AND identity.data_scope_key=$6`,
    [...Object.values(excludedClaims), internalScopeA]
  );
  await pool.query(
    `INSERT INTO gowm_capability.provider_registry(
       provider_id,provider_version,display_name,owner_name,endpoint,manifest_uri,
       endpoint_bindings,manifest_hash,implementation_digest,approval_state,
       approved_by,approved_at,enabled
     ) VALUES (
       $1,'1.0.0','Derived scope fixture','GOWM tests','http://derived-scope.invalid',
       'urn:test:derived-scope-manifest',
       '{"manifest":"/manifest","liveness":"/health/live","readiness":"/health/ready","execute":"/operations/{operationId}:execute","job":"/jobs/{jobId}"}'::jsonb,
       $2,$3,'APPROVED','derived-scope-test',clock_timestamp(),true
     )`,
    [providerId, sha256({ fixture: "derived-scope-manifest" }), sha256({ fixture: "derived-scope-provider" })]
  );
  await pool.query(
    `INSERT INTO gowm_capability.capability(
       operation_id,semantic_role,data_binding,result_semantics,description
     ) VALUES ($1,'GENERIC_ANALYSIS','WORLD_INDEPENDENT','DERIVED_ANALYSIS','derived scope fixture')`,
    [operationId]
  );
  await pool.query(
    `INSERT INTO gowm_capability.provider_operation(
       operation_id,operation_version,provider_id,input_schema_uri,input_schema_hash,
       output_schema_uri,output_schema_hash,maturity,scope_policy,execution_mode,
       execution_bindings,critical_path_policy,default_timeout_ms,maximum_timeout_ms,
       cost_class,limits,ports,data_snapshot_policy,policy_version,enabled
     ) VALUES (
       $1,'1.0',$2,$3,$4,$3,$4,'EXPERIMENTAL','REQUEST_CONTEXT','SYNC',
       ARRAY['EMBEDDED_SDK'],'EMBEDDED_REQUIRED',30000,120000,'LOW',
       '{"maximumRows":10,"maximumCandidates":10}'::jsonb,$5::jsonb,'NONE','derived-scope/1',true
     )`,
    [operationId, providerId, objectSchemaUri, objectSchemaHash, JSON.stringify(descriptor.ports)]
  );
  await pool.query(`
    CREATE OR REPLACE FUNCTION public.gowm_test_non_scope_constraint_failure()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.query_id='derived-scope-other-${runId}'
         AND NEW.result->>'status' IN ('COMPLETED','PARTIAL') THEN
        RAISE EXCEPTION 'unrelated authorization failure'
          USING ERRCODE='42501',CONSTRAINT='gowm_test_unrelated_authorization';
      END IF;
      RETURN NEW;
    END
    $fn$;
    CREATE TRIGGER zz_gowm_test_non_scope_constraint_failure
      BEFORE UPDATE OF result ON gowm_capability.world_query_job
      FOR EACH ROW EXECUTE FUNCTION public.gowm_test_non_scope_constraint_failure();
  `);
}

function buildRuntime(): WorldQueryRuntime {
  const operation: ProviderOperation = {
    descriptor,
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    method: {
      engine: "derived-scope-fixture",
      engineVersion: "1.0.0",
      methodId: "identity",
      methodVersion: "1.0"
    },
    async handle(input) {
      providerCalls += 1;
      return { status: "COMPLETED", value: input, consumption: { rows: 1, candidates: 1 } };
    }
  };
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0",
    provider: {
      providerId,
      providerVersion: "1.0.0",
      owner: "GOWM tests",
      implementationDigest: sha256({ fixture: "derived-scope-provider" })
    },
    endpoints: {
      manifest: "/v1/manifest",
      liveness: "/health/live",
      readiness: "/health/ready",
      execute: "/v1/operations/{operationId}:execute",
      job: "/v1/jobs/{jobId}"
    },
    capabilities: [descriptor]
  };
  const provider = createProviderRuntime({
    manifest,
    operations: [operation],
    policyVersion: "derived-scope/1.0",
    policyDigest: sha256({ policy: "derived-scope/1.0" })
  });
  const registry = new CapabilityRegistry();
  registry.register({
    approvalId: "approval-derived-scope",
    approved: true,
    endpoint: new URL("http://127.0.0.1:1/"),
    client: new InProcessProviderClient(provider),
    manifest
  });
  const direct = new DirectExecutionService({
    registry,
    circuits: new ProviderCircuitBreaker(),
    idempotency: new MemoryGatewayIdempotencyStore(),
    audit: new MemoryAuditSink(),
    gatewayId: "gateway-derived-scope-test",
    policyVersion: "gateway-derived-scope/1.0",
    attestationIssuer: "gateway-derived-scope-test",
    records: new MemoryGatewayRecordStore()
  });
  return new WorldQueryRuntime({
    validator: new QueryPlanValidator(registry),
    directExecution: direct,
    store: new PostgresQueryPlanStore(pool),
    autoRunAsync: false
  });
}

async function persistedState(queryId: string) {
  const result = await pool.query<{
    gateway_state: string;
    failure_code: string | null;
    result_status: string | null;
    resolved_data_scope_key: string | null;
    node_state: string;
    result_reference_count: string;
    result_reference_scope: string | null;
    result_identity_count: string;
    result_identity_scope: string | null;
    result_descriptor_count: string;
    result_descriptor_scope: string | null;
    result_name_count: string;
    result_name_scope: string | null;
    result_projection_count: string;
    result_projection_scope: string | null;
  }>(
    `SELECT gateway.state AS gateway_state,gateway.failure_code,
            query.result->>'status' AS result_status,query.resolved_data_scope_key,
            node.state AS node_state,
            (SELECT count(*)::text FROM public.world_query_result_reference reference WHERE reference.query_id=query.query_id) AS result_reference_count,
            (SELECT min(reference.data_scope_key) FROM public.world_query_result_reference reference WHERE reference.query_id=query.query_id) AS result_reference_scope,
            (SELECT count(*)::text FROM public.world_reference_identity identity WHERE identity.entity_kind='QUERY_RESULT' AND identity.internal_id=query.query_id) AS result_identity_count,
            (SELECT min(identity.data_scope_key) FROM public.world_reference_identity identity WHERE identity.entity_kind='QUERY_RESULT' AND identity.internal_id=query.query_id) AS result_identity_scope,
            (SELECT count(*)::text FROM public.world_reference_descriptor_version descriptor JOIN public.world_reference_identity identity USING(reference_key) WHERE identity.entity_kind='QUERY_RESULT' AND identity.internal_id=query.query_id) AS result_descriptor_count,
            (SELECT min(descriptor.data_scope_key) FROM public.world_reference_descriptor_version descriptor JOIN public.world_reference_identity identity USING(reference_key) WHERE identity.entity_kind='QUERY_RESULT' AND identity.internal_id=query.query_id) AS result_descriptor_scope,
            (SELECT count(*)::text FROM public.world_reference_name name JOIN public.world_reference_identity identity USING(reference_key) WHERE identity.entity_kind='QUERY_RESULT' AND identity.internal_id=query.query_id) AS result_name_count,
            (SELECT min(name.data_scope_key) FROM public.world_reference_name name JOIN public.world_reference_identity identity USING(reference_key) WHERE identity.entity_kind='QUERY_RESULT' AND identity.internal_id=query.query_id) AS result_name_scope,
            (SELECT count(*)::text FROM public.reference_search_projection projection JOIN public.world_reference_identity identity USING(reference_key) WHERE identity.entity_kind='QUERY_RESULT' AND identity.internal_id=query.query_id) AS result_projection_count,
            (SELECT min(projection.data_scope_key) FROM public.reference_search_projection projection JOIN public.world_reference_identity identity USING(reference_key) WHERE identity.entity_kind='QUERY_RESULT' AND identity.internal_id=query.query_id) AS result_projection_scope
     FROM gowm_capability.world_query_job query
     JOIN gowm_capability.gateway_job gateway USING(job_id)
     JOIN gowm_capability.world_query_node_execution node USING(job_id)
     WHERE query.query_id=$1`,
    [queryId]
  );
  return result.rows[0];
}

describe.skipIf(!enabled)("derived World Query result scope resolution on PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    descriptor = fixtureDescriptor();
    await installFixture();
    runtime = buildRuntime();
  });

  afterAll(async () => {
    await pool?.query("DROP TRIGGER IF EXISTS zz_gowm_test_non_scope_constraint_failure ON gowm_capability.world_query_job");
    await pool?.query("DROP FUNCTION IF EXISTS public.gowm_test_non_scope_constraint_failure()");
    await pool?.end();
  });

  it("persists one mapped terminal result and rejects unmapped or ambiguous claims after Provider completion", async () => {
    const positiveQueryId = `derived-scope-positive-${runId}`;
    const completed = await runtime.submit(
      submission(positiveQueryId),
      principal(mappedClaim, "positive")
    );
    expect(completed.result?.status).toBe("COMPLETED");
    expect(completed.job.status).toBe("COMPLETED");
    expect(await persistedState(positiveQueryId)).toEqual({
      gateway_state: "SUCCEEDED",
      failure_code: null,
      result_status: "COMPLETED",
      resolved_data_scope_key: internalScopeA,
      node_state: "COMPLETED",
      result_reference_count: "1",
      result_reference_scope: internalScopeA,
      result_identity_count: "1",
      result_identity_scope: internalScopeA,
      result_descriptor_count: "1",
      result_descriptor_scope: internalScopeA,
      result_name_count: "1",
      result_name_scope: internalScopeA,
      result_projection_count: "1",
      result_projection_scope: internalScopeA
    });

    for (const [kind, claim] of [["unmapped", unmappedClaim], ["ambiguous", ambiguousClaim]] as const) {
      const queryId = `derived-scope-${kind}-${runId}`;
      await expect(runtime.submit(
        submission(queryId),
        principal(claim, kind)
      )).rejects.toMatchObject({
        code: "SCOPE_DENIED",
        retryable: false,
        details: { stage: "DAG_EXECUTION" }
      });
      expect(await persistedState(queryId)).toEqual({
        gateway_state: "FAILED",
        failure_code: "SCOPE_DENIED",
        result_status: null,
        resolved_data_scope_key: null,
        node_state: "COMPLETED",
        result_reference_count: "0",
        result_reference_scope: null,
        result_identity_count: "0",
        result_identity_scope: null,
        result_descriptor_count: "0",
        result_descriptor_scope: null,
        result_name_count: "0",
        result_name_scope: null,
        result_projection_count: "0",
        result_projection_scope: null
      });
    }

    expect(providerCalls).toBe(3);
  });

  it("excludes non-authoritative claim mappings and does not remap unrelated 42501 errors", async () => {
    const callsBefore = providerCalls;
    for (const claim of Object.values(excludedClaims)) {
      await expect(pool.query(
        "SELECT gowm_capability.resolve_data_scope_claim($1)",
        [claim]
      )).rejects.toMatchObject({
        code: "42501",
        constraint: "world_query_result_scope_claim_resolution"
      });
    }

    await expect(runtime.submit(
      submission(`derived-scope-other-${runId}`),
      principal(mappedClaim, "other-42501")
    )).rejects.toMatchObject({
      code: "42501",
      constraint: "gowm_test_unrelated_authorization"
    });
    expect(providerCalls).toBe(callsBefore + 1);
  });
});
