import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalSha256,
  validateCapabilityDescriptorSemantics,
  validateContract,
  validateSchemaSet,
  validateWorldQueryResultSemantics,
  type CapabilityDescriptor,
  type WorldQueryResult
} from "../../packages/platform/contract-runtime/src/index.js";
import { validateVocabularyExtension } from "../../packages/platform/semantic-conformance/src/index.js";

const digest = `sha256:${"a".repeat(64)}`;

function snapshot() {
  const body = {
    querySnapshotId: "snapshot-contract-test",
    mode: "PINNED",
    consistency: "PINNED",
    capturedAt: "2026-08-30T00:00:00.000Z",
    resources: [{
      resourceKind: "TRACKLET_VERSION",
      resourceId: "source-a:tracklet-1",
      version: "1",
      contentHash: digest,
      worldVersion: 7,
      pinning: "PINNED"
    }]
  };
  return { ...body, manifestHash: canonicalSha256(body) };
}

function descriptor(
  dataBinding: CapabilityDescriptor["dataBinding"],
  dataSnapshot: CapabilityDescriptor["snapshotPolicy"]["dataSnapshot"],
  resourceResolution?: CapabilityDescriptor["snapshotPolicy"]["resourceResolution"]
): CapabilityDescriptor {
  return {
    operationId: "test.snapshot.behavior",
    operationVersion: "1.0",
    semanticRole: "GENERIC_ANALYSIS",
    dataBinding,
    resultSemantics: "DERIVED_ANALYSIS",
    executionBindings: ["SYNC_HTTP"],
    criticalPathPolicy: "REMOTE_ONLY",
    maturity: "PREVIEW",
    inputSchemaUri: "urn:gowm:v0.2:value:object",
    inputSchemaHash: digest,
    outputSchemaUri: "urn:gowm:v0.2:value:object",
    outputSchemaHash: digest,
    scopePolicy: dataBinding === "WORLD_SNAPSHOT_BOUND" ? "DATA_SCOPE_REQUIRED"
      : dataBinding === "DATASET_VERSION_BOUND" ? "DATASET_SCOPE_REQUIRED" : "REQUEST_CONTEXT",
    execution: { mode: "SYNC", defaultTimeoutMs: 100, maximumTimeoutMs: 1_000, costClass: "LOW" },
    limits: { maximumInputBytes: 1024, maximumOutputBytes: 1024 },
    snapshotPolicy: {
      dataSnapshot,
      computeSnapshot: "REQUIRED",
      ...(resourceResolution === undefined ? {} : { resourceResolution })
    },
    ports: {
      inputs: [{ name: "request", schemaUri: "urn:gowm:v0.2:value:object", schemaHash: digest, valueKind: "ANY", unitSemantics: "UNSPECIFIED" }],
      outputs: [{ name: "result", schemaUri: "urn:gowm:v0.2:value:object", schemaHash: digest, valueKind: "ANY", unitSemantics: "UNSPECIFIED" }]
    }
  };
}

describe("GOWM v0.7 contract prerelease", () => {
  it("generates a closed, reference-complete schema set", () => {
    expect(validateSchemaSet()).toEqual({ valid: true, issues: [] });
  });

  it("keeps the frozen v0.6.3 snapshot payload valid and admits the v0.7 equivalent", () => {
    const value = snapshot();
    expect(validateContract("urn:gowm:v0.6.3:query-snapshot-manifest", value).valid).toBe(true);
    expect(validateContract("urn:gowm:v0.7:query-snapshot-manifest", value).valid).toBe(true);
    expect(validateContract("urn:gowm:v0.7:query-snapshot-manifest", {
      ...value,
      manifestHash: `sha256:${"0".repeat(64)}`
    }).issues).toEqual(expect.arrayContaining([expect.objectContaining({ keyword: "manifestHash" })]));
  });

  it("enforces resourceResolution descriptor combinations without changing legacy behavior", () => {
    expect(validateCapabilityDescriptorSemantics(descriptor("WORLD_SNAPSHOT_BOUND", "REQUIRED", "DISCOVER_RESOURCES")).valid).toBe(true);
    expect(validateCapabilityDescriptorSemantics(descriptor("DATASET_VERSION_BOUND", "REQUIRED", "REQUIRE_PINNED")).valid).toBe(true);
    expect(validateCapabilityDescriptorSemantics(descriptor("CALLER_DATA_BOUND", "REQUIRED", "DISCOVER_RESOURCES")).valid).toBe(true);
    expect(validateCapabilityDescriptorSemantics(descriptor("CALLER_DATA_BOUND", "REQUIRED", "REQUIRE_PINNED")).valid).toBe(true);
    expect(validateCapabilityDescriptorSemantics(descriptor("WORLD_INDEPENDENT", "NONE", "NOT_APPLICABLE")).valid).toBe(true);
    expect(validateCapabilityDescriptorSemantics(descriptor("WORLD_INDEPENDENT", "NONE")).valid).toBe(true);
    expect(validateCapabilityDescriptorSemantics(descriptor("WORLD_INDEPENDENT", "NONE", "DISCOVER_RESOURCES")).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ keyword: "resourceResolution" })]));
    expect(validateCapabilityDescriptorSemantics(descriptor("WORLD_SNAPSHOT_BOUND", "REQUIRED", "NOT_APPLICABLE")).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ keyword: "resourceResolution" })]));
  });

  it("requires requested/effective snapshot fields as a pair while retaining legacy results", () => {
    const legacy = { snapshotManifest: snapshot() } as unknown as WorldQueryResult;
    expect(validateWorldQueryResultSemantics(legacy).valid).toBe(true);
    const current = {
      snapshotManifest: snapshot(),
      requestedSnapshotManifest: snapshot(),
      effectiveSnapshotManifest: snapshot()
    } as unknown as WorldQueryResult;
    expect(validateWorldQueryResultSemantics(current).valid).toBe(true);
    const { effectiveSnapshotManifest: _effective, ...requestedOnly } = current;
    expect(validateWorldQueryResultSemantics(requestedOnly).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "snapshotManifestPair" })
    ]));
  });

  it("version-gates the additive historical reference kinds", () => {
    const profile = {
      profileVersion: "1.1",
      domain: "TEMPORAL",
      acceptedReferenceKinds: ["OPERATIONAL_TASK"],
      producedReferenceKinds: ["TASK_EXECUTION_INTERVAL"],
      relationSemantics: ["TEMPORALLY_OVERLAPS"],
      spatialSemantics: "NONE",
      timeSemantics: "HISTORICAL",
      resultNature: "PROJECTION",
      negativeEvidencePolicy: "NO_DATA_IS_UNKNOWN",
      freshnessSemantics: "SNAPSHOT_CURRENTNESS"
    };
    expect(validateContract("urn:gowm:v0.7:capability-semantic-profile", profile).valid).toBe(true);
    expect(validateContract("urn:gowm:v0.7:capability-semantic-profile", { ...profile, profileVersion: "1.0" }).valid).toBe(false);
  });

  it("keeps the reference vocabulary additive with frozen prior meanings", () => {
    const baseline = JSON.parse(readFileSync(new URL("../../contracts/gowm-v0.6.2/vocabularies/reference-kind-vocabulary.v1.json", import.meta.url), "utf8"));
    const candidate = JSON.parse(readFileSync(new URL("../../contracts/gowm-v0.7/vocabularies/reference-kind-vocabulary.v2.json", import.meta.url), "utf8"));
    expect(validateVocabularyExtension(baseline, candidate)).toEqual([]);
    expect(candidate.terms.map((term: { id: string }) => term.id)).toEqual(expect.arrayContaining([
      "TASK_EXECUTION_INTERVAL",
      "TASK_EXECUTION_EVENT_SET",
      "TRACKLET_VERSION",
      "TRACKLET_FINALIZATION",
      "HISTORICAL_TRAJECTORY",
      "HISTORY_INPUT_SET",
      "HISTORY_METHOD_PROFILE"
    ]));
  });

  it("validates the strict historical query/result shapes and separates paused exclusions from unknown gaps", () => {
    const intervalKey = { namespace: "gowm", kind: "TASK_EXECUTION_INTERVAL", id: "task-1:execution-1", version: "1" };
    const subjectKey = { namespace: "gowm", kind: "WORLD_OBJECT", id: "vehicle-2", version: "7" };
    const query = {
      subjectReferenceKey: subjectKey,
      executionIntervalReferenceKey: intervalKey,
      phaseScope: "ACTIVE_PHASES_ONLY",
      sourceSelection: { mode: "ONLY_CANDIDATE" },
      sourceSelectionProfileReferenceKey: { namespace: "gowm", kind: "HISTORY_METHOD_PROFILE", id: "source-policy", version: "1" },
      maximumInlinePoints: 100
    };
    expect(validateContract("urn:gowm:v0.7:historical-trajectory-query", query).valid).toBe(true);
    const range = { start: "2026-08-30T00:00:00.000Z", end: "2026-08-30T00:01:00.000Z", bounds: "[)" };
    const result = {
      schemaVersion: "1.0",
      status: "PARTIAL",
      reasonCode: "SOURCE_COVERAGE_INCOMPLETE",
      subjectReferenceKey: subjectKey,
      executionIntervalReferenceKey: intervalKey,
      requestedPeriods: [range],
      definedPeriods: [],
      excludedPeriods: [{ range, reason: "EXCLUDED_PAUSED_PHASE" }],
      gaps: [{ range, reason: "SOURCE_COVERAGE_GAP" }],
      inputTrackletVersions: [],
      completeness: { temporalCoverageRatio: 0, sampleCount: 0, sequenceCount: 0, gapCount: 1, prefixComplete: false, suffixComplete: false },
      finalization: { state: "PROVISIONAL" },
      preview: [],
      warnings: []
    };
    expect(validateContract("urn:gowm:v0.7:historical-trajectory-result", result).valid).toBe(true);
    expect(validateContract("urn:gowm:v0.7:historical-trajectory-result", {
      ...result,
      gaps: [{ range, reason: "EXCLUDED_PAUSED_PHASE" }]
    }).valid).toBe(false);
  });
});
