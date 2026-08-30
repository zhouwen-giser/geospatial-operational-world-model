import { describe, expect, it } from "vitest";
import {
  assertSampleDatabase,
  parseMaximumMigrationNumber,
  SAMPLE_LOADER_REQUIRED_ACL_SQL,
  sampleResetFunctionSql
} from "../../scripts/bootstrap-wsgs-sample.js";
import {
  assertSampleDatabaseConnection,
  parseSampleWorldFaultInjection,
  sampleDatabaseMarker,
  sampleRuntimeInstanceIdForDatabaseName,
  sampleFixtureEvidenceReference,
  sampleObservationRecordIdentity,
  validatedSampleDatabaseName
} from "../../scripts/sample-world/database.js";
import {
  assertLiveSampleDatabaseIdentity,
  sampleRuntimeDatabaseName
} from "../../scripts/sample-world/readiness.js";
import type { SampleRuntimeEnvironment } from "../../scripts/sample-world/runtime.js";

const QUALIFICATION_DATABASE = "gowm_wsgs_sample_q_9313668_a1";
const SAMPLE_RESET_FUNCTION_SQL = sampleResetFunctionSql(QUALIFICATION_DATABASE);

describe("sample-world mutation observation identity", () => {
  const baseline = {
    observationKey: "obs:ugv-002:v1",
    sourceRecordKey: "obs:ugv-002:v1"
  };
  const mutation = {
    ...baseline,
    observationKey: "obs:ugv-002:v2",
    sourceRevisionNo: 2,
    supersedesObservationKey: baseline.observationKey
  };

  it("keeps the v2 mutation in the v1 source-record revision lineage", () => {
    expect(sampleObservationRecordIdentity(mutation)).toEqual({
      observationKey: "obs:ugv-002:v2",
      sourceRecordKey: "obs:ugv-002:v1",
      rawReference: "sample://gowm-wsgs-sample-world/observation/obs%3Augv-002%3Av2"
    });
  });

  it("derives the same immutable identity when the mutation is repeated", () => {
    const firstMutation = sampleObservationRecordIdentity(mutation);
    const repeatedMutation = sampleObservationRecordIdentity({ ...mutation });

    expect(repeatedMutation).toEqual(firstMutation);
    expect(repeatedMutation.sourceRecordKey).toBe(baseline.sourceRecordKey);
    expect(repeatedMutation.observationKey).toBe(mutation.observationKey);
  });

  it("falls back to observationKey for a baseline record without an explicit lineage key", () => {
    expect(sampleObservationRecordIdentity({ observationKey: "obs:ugv-001:v1" }).sourceRecordKey)
      .toBe("obs:ugv-001:v1");
  });
});

describe("sample-world first-load fault gate", () => {
  it("normalizes fixture provenance to the public EvidenceRef contract", () => {
    expect(sampleFixtureEvidenceReference({
      fixtureId: "gowm-wsgs-sample-world",
      fixtureVersion: "1.0.0",
      fixtureKey: "ugv-002",
      syntheticTestData: true
    }, "wrf_test")).toEqual({
      evidenceId: "sample://gowm-wsgs-sample-world/1.0.0/ugv-002",
      authority: "GOWM Synthetic Test Fixture",
      evidenceType: "SYNTHETIC_FIXTURE"
    });
  });
  it("is disabled unless an explicit test-only stage is configured", () => {
    expect(parseSampleWorldFaultInjection({})).toBeUndefined();
    expect(() => parseSampleWorldFaultInjection({ SAMPLE_WORLD_FAULT_AFTER_COUNT: "2" }))
      .toThrow(/requires SAMPLE_WORLD_FAULT_AFTER_STAGE/u);
  });

  it("accepts a bounded deterministic observation failure point", () => {
    expect(parseSampleWorldFaultInjection({
      SAMPLE_WORLD_FAULT_AFTER_STAGE: "observation-insert",
      SAMPLE_WORLD_FAULT_AFTER_COUNT: "3",
      GOWM_ENV: "test"
    })).toMatchObject({
      stage: "observation-insert",
      afterCount: 3,
      observedCount: 0,
      triggered: false
    });
  });

  it("rejects invalid counts, unknown stages, and production use", () => {
    expect(() => parseSampleWorldFaultInjection({
      SAMPLE_WORLD_FAULT_AFTER_STAGE: "observation-insert",
      SAMPLE_WORLD_FAULT_AFTER_COUNT: "0"
    })).toThrow(/positive integer/u);
    expect(() => parseSampleWorldFaultInjection({ SAMPLE_WORLD_FAULT_AFTER_STAGE: "unknown" }))
      .toThrow(/Unsupported/u);
    expect(() => parseSampleWorldFaultInjection({
      SAMPLE_WORLD_FAULT_AFTER_STAGE: "projection",
      GOWM_ENV: "production"
    })).toThrow(/never authorized in production/u);
  });
});

describe("sample-world qualification database identity", () => {
  const runtime = {
    paths: {} as SampleRuntimeEnvironment["paths"],
    values: {
      SAMPLE_WORLD_INSTANCE_ID: "q-9313668-a1",
      GATEWAY_PORT: "28064",
      POSTGRES_PORT: "65464",
      POSTGRES_DB: QUALIFICATION_DATABASE
    }
  } satisfies SampleRuntimeEnvironment;

  it("binds loader, bootstrap, readiness and reset SQL to the same qualification database", () => {
    const connectionString = `postgresql://sample:secret@postgres:5432/${QUALIFICATION_DATABASE}`;
    expect(assertSampleDatabaseConnection(connectionString, QUALIFICATION_DATABASE)).toBe(QUALIFICATION_DATABASE);
    expect(assertSampleDatabase(connectionString, QUALIFICATION_DATABASE)).toBe(QUALIFICATION_DATABASE);
    expect(sampleRuntimeDatabaseName(runtime)).toBe(QUALIFICATION_DATABASE);
    expect(assertLiveSampleDatabaseIdentity(runtime, QUALIFICATION_DATABASE)).toBe(QUALIFICATION_DATABASE);
    expect(sampleDatabaseMarker(QUALIFICATION_DATABASE))
      .toBe(`${QUALIFICATION_DATABASE}/gowm-wsgs-sample-world/1.0`);
    expect(sampleRuntimeInstanceIdForDatabaseName(QUALIFICATION_DATABASE)).toBe("q-9313668-a1");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain(`current_database() <> '${QUALIFICATION_DATABASE}'`);
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("runtime_instance_id='q-9313668-a1'");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain(`database_name='${QUALIFICATION_DATABASE}'`);
    expect(SAMPLE_RESET_FUNCTION_SQL)
      .toContain(`'databaseMarker','${QUALIFICATION_DATABASE}/gowm-wsgs-sample-world/1.0'`);
  });

  it("rejects URL, runtime and live-database drift and unsafe SQL identities", () => {
    expect(() => assertSampleDatabaseConnection(
      "postgresql://sample:secret@postgres:5432/gowm_wsgs_sample",
      QUALIFICATION_DATABASE
    )).toThrow(/differs from validated POSTGRES_DB/u);
    expect(() => sampleRuntimeDatabaseName({
      ...runtime,
      values: { ...runtime.values, POSTGRES_DB: "gowm_wsgs_sample" }
    })).toThrow(/differs from the validated runtime identity/u);
    expect(() => assertLiveSampleDatabaseIdentity(runtime, "gowm_wsgs_sample"))
      .toThrow(/differs from validated runtime POSTGRES_DB/u);
    expect(() => validatedSampleDatabaseName("sample'; DROP DATABASE postgres; --"))
      .toThrow(/bounded q-\*/u);
    expect(() => sampleResetFunctionSql("sample'; DROP DATABASE postgres; --"))
      .toThrow(/bounded q-\*/u);
    expect(() => sampleResetFunctionSql(QUALIFICATION_DATABASE, "q-other"))
      .toThrow(/differs from the qualification database/u);
  });
});

describe("sample-world bounded migration CLI input", () => {
  it("keeps full migration as the default and accepts exact three-digit bounds", () => {
    expect(parseMaximumMigrationNumber(undefined)).toBeUndefined();
    expect(parseMaximumMigrationNumber("001")).toBe(1);
    expect(parseMaximumMigrationNumber("061")).toBe(61);
    expect(parseMaximumMigrationNumber("999")).toBe(999);
  });

  it.each(["", "61", "0061", "000", " 061", "061 ", "+61", "abc"])(
    "rejects non-canonical migration bound %j",
    (value) => {
      expect(() => parseMaximumMigrationNumber(value)).toThrow(/GOWM_MAXIMUM_MIGRATION_NUMBER/u);
    }
  );
});

describe("sample-world protected reset SQL", () => {
  it("guards the marker and null or foreign scopes before mutation", () => {
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("sample reset database marker mismatch");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("data_scope_key IS NULL OR data_scope_key NOT IN");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("data_scope_claim IS NULL OR data_scope_claim NOT IN");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("sample reset refuses % unowned rows");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("fixture_cell.h3_index=cell.h3_index::text");
  });

  it("discovers and proves the complete foreign-key truncate closure", () => {
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("WITH RECURSIVE dependency_closure");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("constraint_record.confrelid=dependency_closure.relation_oid");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("parent.proven_safe");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("guard_kind='SAMPLE_IDEMPOTENCY'");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("idempotency.idempotency_key LIKE 'sample-%'");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("CREATE TEMP TABLE sample_reset_owned_idempotency");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("audit_event.operation_id=idempotency.operation_id");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("audit_event.operation_version=idempotency.operation_version");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("audit_event.request_hash=idempotency.request_hash");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("owned.idempotency_record_id=idempotency.idempotency_record_id");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("owned.receipt_id=receipt.receipt_id");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("guard_kind='SAMPLE_GATEWAY_AUDIT'");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("audit_event.data_scope_hash IS NULL OR NOT EXISTS");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("unnest(marker.allowed_data_scopes)");
    expect(SAMPLE_RESET_FUNCTION_SQL).toMatch(
      /table_name='gateway_job'\s+AND proven_safe/u
    );
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("sample reset cannot prove ownership");
    expect(SAMPLE_RESET_FUNCTION_SQL.indexOf("sample reset cannot prove ownership"))
      .toBeLessThan(SAMPLE_RESET_FUNCTION_SQL.indexOf("TRUNCATE TABLE"));
  });

  it("measures before and after impact instead of hard-coding zero", () => {
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("'affectedRowsBefore',affected_rows_before");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("'affectedRowsAfter',affected_rows_after");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("'nonFixtureRowsBefore',non_fixture_rows_before");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("'nonFixtureRowsAffected',abs(protected_rows_before-protected_rows_after)");
    expect(SAMPLE_RESET_FUNCTION_SQL).not.toContain("'nonFixtureRowsAffected',0");
  });

  it("preserves migration and marker state and deletes only linked fixture processing runs", () => {
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("namespace.nspname NOT IN ('pg_catalog','information_schema','gowm_sample_fixture')");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("JOIN public.world_observation observation_record");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("USING pg_temp.sample_reset_processing_run owned_run");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("DISABLE TRIGGER processing_run_immutable");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("ENABLE TRIGGER processing_run_immutable");
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("entity_kind<>'DATA_SCOPE'");
    expect(SAMPLE_RESET_FUNCTION_SQL).not.toContain("processor_name='gowm-canonical-ingest'");
    expect(SAMPLE_RESET_FUNCTION_SQL).not.toMatch(/DELETE FROM public\.data_scope/iu);
    expect(SAMPLE_RESET_FUNCTION_SQL).not.toMatch(/TRUNCATE TABLE\s+schema_migration/iu);
    expect(SAMPLE_RESET_FUNCTION_SQL).not.toMatch(/TRUNCATE TABLE\s+gowm_sample_fixture\.instance_marker/iu);
  });

  it("preserves default-scope reference catalog rows while deleting sample-scope rows", () => {
    expect(SAMPLE_RESET_FUNCTION_SQL).toMatch(
      /relation\.relname IN \([\s\S]*'world_reference_identity','world_reference_descriptor_version','world_reference_name',[\s\S]*'world_reference_external_identifier','reference_search_projection'/u
    );
    for (const table of [
      "reference_search_projection",
      "world_reference_external_identifier",
      "world_reference_name",
      "world_reference_descriptor_version"
    ]) {
      expect(SAMPLE_RESET_FUNCTION_SQL).toContain(`DELETE FROM public.${table}`);
    }
    for (const trigger of [
      "world_reference_external_identifier_immutable",
      "world_reference_name_immutable",
      "world_reference_descriptor_version_immutable"
    ]) {
      expect(SAMPLE_RESET_FUNCTION_SQL).toContain(`DISABLE TRIGGER ${trigger}`);
      expect(SAMPLE_RESET_FUNCTION_SQL).toContain(`ENABLE TRIGGER ${trigger}`);
    }
    expect(SAMPLE_RESET_FUNCTION_SQL).toContain("'referenceCatalogRows',sample_reference_catalog_rows_before");
    expect(SAMPLE_RESET_FUNCTION_SQL).toMatch(
      /world_reference_descriptor_version[\s\S]*WHERE data_scope_key NOT IN \('wsgs-demo','wsgs-hidden'\)/u
    );
  });
});

describe("sample-world restricted loader ACL", () => {
  const normalizedAcl = SAMPLE_LOADER_REQUIRED_ACL_SQL.replace(/\s+/gu, " ").trim();

  it("grants the minimum table access needed by the invoker-rights mobility rebuild", () => {
    expect(normalizedAcl).toContain(
      "GRANT SELECT ON TABLE tracklet_rule_profile,mobility_tracklet_version TO gowm_sample_loader_service"
    );
    expect(normalizedAcl).toContain(
      "GRANT INSERT ON TABLE mobility_tracklet_version,mobility_tracklet_segment,mobility_tracklet_gap, mobility_tracklet_input,mobility_tracklet_lineage TO gowm_sample_loader_service"
    );
    expect(normalizedAcl).toContain(
      "GRANT EXECUTE ON FUNCTION gowm_tracklet_candidates(text,text,text,text,text,text), gowm_rebuild_mobility_tracklet(text,text,text,text,text,text) TO gowm_sample_loader_service"
    );
  });

  it("allows only the area-membership delete needed by the v2 geofence exit", () => {
    expect(normalizedAcl).toContain(
      "GRANT DELETE ON TABLE object_area_membership TO gowm_sample_loader_service"
    );
    expect(normalizedAcl).not.toMatch(/GRANT (?:ALL|TRUNCATE)/u);
    expect(normalizedAcl.match(/GRANT DELETE ON TABLE/gu)).toHaveLength(1);
  });
});
