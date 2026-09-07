import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { OperationalEventRepository } from "../../packages/runtime/src/operational-event-repository.js";
import { OperationalProjectionRepository } from "../../packages/runtime/src/operational-projection-repository.js";
import { OperationalReadRepository } from "../../packages/runtime/src/operational-read-repository.js";
import { createOperationalRealityProvider } from "../../services/providers/operational-reality-provider/src/provider.js";
import { buildOperationalRealityApp } from "../../services/providers/operational-reality-provider/src/app.js";

const source = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error("DATABASE_ADMIN_URL is required (isolated test server only)");
const adminUrl = new URL(source); adminUrl.pathname = "/postgres";
const admin = new pg.Pool({connectionString: adminUrl.toString(), max: 1});
const run = promisify(execFile);
try {
  for (const baseline of [0, 75]) {
    const suffix = randomUUID().replaceAll("-", "");
    const database = `gowm_operational_closure_${suffix}`;
    const role = `closure_reader_${suffix}`;
    const target = new URL(source); target.pathname = `/${database}`;
    const password = randomUUID();
    let created = false, roleCreated = false;
    let setup: pg.Pool | undefined, reader: pg.Pool | undefined;
    const migrate = async (maximum: number) => run(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e",
        `import {migrate} from './scripts/migrate.ts'; await migrate({maximumMigrationNumber:${maximum}});`],
      {env: {...process.env, DATABASE_URL: target.toString(), ANALYSIS_SRID: "32648",
        STAS_DB_PASSWORD: "closure-disposable-stas"}, maxBuffer: 4 * 1024 * 1024});
    try {
      await admin.query(`CREATE DATABASE "${database}"`); created = true;
      setup = new pg.Pool({connectionString: target.toString(), max: 2});
      await migrate(baseline || 76);
      const beforeLedger = (await setup.query("SELECT version,checksum FROM schema_migration ORDER BY version")).rows;
      for (const scope of ["closure-a", "closure-b"]) {
        await setup.query("INSERT INTO data_scope(scope_key,operational_domain,description) VALUES ($1,'TEST','isolated closure regression')", [scope]);
      }
      const eventTime = new Date(Date.now()-30_000).toISOString();
      await new OperationalEventRepository(setup).insert({
        dataScopeKey: "closure-a", sourceAuthority: "closure-source", sourceEventKey: "closure-event", sourceRevisionNo: 1,
        eventId: "closure-event", operationalTaskId: "closure-task", eventType: "EXECUTION_STOPPED_OBSERVED",
        eventTime, actorReferenceKeys: [], targetReferenceKeys: [], payload: {taskType: "CLOSURE_TEST"}, confidence: 1,
        provenance: [{evidenceId: "closure-evidence", authority: "closure-source", evidenceType: "PROVIDER_EVENT", observedAt: eventTime}]
      }, new Date().toISOString());
      const projections = new OperationalProjectionRepository(setup);
      await projections.projectPending(100);
      const before = await projections.get("closure-a", "closure-task"); assert.ok(before);
      await setup.query("INSERT INTO world_object(id,object_type,data_scope_key) VALUES ('closure-world','UGV','closure-a')");
      await setup.query("INSERT INTO world_object_state(object_id,source) VALUES ('closure-world','closure-gnss')");
      const worldReference = (await setup.query("SELECT reference_key FROM world_reference_identity WHERE entity_kind='WORLD_OBJECT' AND internal_id='closure-world'")).rows[0].reference_key;
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      roleCreated = true;
      await admin.query(`GRANT gowm_operational_service TO "${role}"`);
      const login = new URL(target); login.username = role; login.password = password;
      reader = new pg.Pool({connectionString: login.toString(), max: 1});
      const provider = createOperationalRealityProvider({pool: reader});
      const app = buildOperationalRealityApp(provider, "ClosureTestTransportToken_2026_IsolatedOnly");
      try {
        if (baseline) assert.equal((await app.inject({method: "GET", url: "/health/ready"})).statusCode, 503);
        await migrate(76);
        const ledger = (await setup.query("SELECT version,checksum FROM schema_migration ORDER BY version")).rows;
        assert.equal(ledger.length, 76);
        assert.deepEqual(ledger.slice(0, beforeLedger.length), beforeLedger);
        await migrate(76);
        assert.deepEqual((await setup.query("SELECT version,checksum FROM schema_migration ORDER BY version")).rows, ledger);
        assert.deepEqual(await projections.get("closure-a", "closure-task"), before);
        assert.equal((await reader.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper, false);
        assert.equal((await app.inject({method: "GET", url: "/health/ready"})).statusCode, 200);
        const result = await provider.repository.execute("operational-task.get", {referenceKey: before.referenceKey}, "closure-a");
        assert.equal(result.status, "COMPLETED"); assert.equal(result.rows, 1);
        assert.deepEqual(result.output, before);
        const descriptor = provider.runtime.manifest.capabilities.find((item) => item.operationId === "operational-task.get")!;
        const now = new Date().toISOString(), deadlineAt = new Date(Date.now()+30_000).toISOString();
        const http = await app.inject({method: "POST", url: "/v1/operations/operational-task.get:execute",
          headers: {authorization: "Bearer ClosureTestTransportToken_2026_IsolatedOnly"}, payload: {
            providerProtocolVersion: "1.0", requestId: "closure-get", gatewayRequestId: "closure-get", idempotencyKey: "closure-get",
            operation: {operationId: descriptor.operationId, operationVersion: descriptor.operationVersion,
              inputSchemaHash: descriptor.inputSchemaHash, outputSchemaHash: descriptor.outputSchemaHash},
            input: {schemaVersion: "1.0", referenceKey: before.referenceKey},
            securityContext: {principalRef: "closure", authenticationMethod: "TEST_ATTESTED", authenticatedAt: now,
              dataScopeClaim: "closure-a", scopeAttestation: {issuer: "closure", issuedAt: now, expiresAt: deadlineAt,
                claimDigest: sha256({principal: "closure"})}},
            gatewayContext: {gatewayId: "closure", registryVersion: "current", policyVersion: "current"},
            executionPolicy: {deadlineAt, maximumInputBytes: 1048576, maximumResultBytes: 1048576, maximumCostClass: "HIGH"}
          }});
        assert.equal(http.statusCode, 200, http.body);
        assert.equal(http.json().output.value.operationalTaskId, "closure-task");
        const expectedScope = (await setup.query("SELECT reference_key FROM world_reference_identity WHERE data_scope_key='closure-a' AND entity_kind='DATA_SCOPE'")).rows[0].reference_key;
        assert.equal(result.dataSnapshot.resources[0]?.referenceKey.id, expectedScope);
        const timeline = await provider.repository.execute("operational-task.get-timeline", {referenceKey: before.referenceKey}, "closure-a");
        assert.equal(timeline.rows, 1);
        const other = await provider.repository.execute("operational-task.get", {referenceKey: before.referenceKey}, "closure-b");
        assert.equal(other.status, "NO_DATA"); assert.equal(other.rows, 0);
        const reads = new OperationalReadRepository(reader);
        assert.deepEqual(await reads.sources("closure-a", before.referenceKey.id), ["closure-source"]);
        assert.deepEqual(await reads.sources("closure-b", before.referenceKey.id), []);
        assert.deepEqual(await reads.sources("closure-a", worldReference), ["closure-gnss"]);
        assert.deepEqual(await reads.sources("closure-b", worldReference), []);
        await assert.rejects(() => provider.repository.execute("operational-task.get", {}, "missing-scope"));
        for (const table of ["world_reference_identity", "world_object_state", "operational_task_event"]) {
          await assert.rejects(() => reader!.query(`SELECT * FROM public.${table} LIMIT 0`), {code: "42501"});
        }
        assert.equal((await reader.query("SELECT * FROM gowm_operational_reality_v1.scope_identity")).rowCount, 0, "transaction-local scope must not leak");
        await setup.query("REVOKE SELECT ON gowm_operational_reality_v1.scope_identity FROM gowm_operational_reader");
        assert.equal((await app.inject({method: "GET", url: "/health/ready"})).statusCode, 503);
        await setup.query("GRANT SELECT ON gowm_operational_reality_v1.scope_identity TO gowm_operational_reader");
        assert.equal((await app.inject({method: "GET", url: "/health/ready"})).statusCode, 200);
        console.log(JSON.stringify({status: "PASS", baseline, migration: 76, task: before.referenceKey,
          execute: "PASS", readiness: "PASS", scopeIsolation: "PASS", baseTablesDenied: "PASS", oldEvidenceStable: "PASS"}));
      } finally { await app.close(); }
    } finally {
      await reader?.end(); await setup?.end();
      if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
    }
  }
} finally { await admin.end(); }
