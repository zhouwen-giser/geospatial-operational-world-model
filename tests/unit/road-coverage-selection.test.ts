import { describe, expect, it } from "vitest";

import { validateContract } from "../../packages/platform/contract-runtime/src/index.js";
import {
  CoveragePlanningError,
  canonicalObligationLedger,
  obligationSetHash,
  selectRoadServiceObligations
} from "../../packages/road-coverage-planning-core/src/index.js";
import type {
  CoverageSelectionCandidate,
  CoverageSelectionRepository,
  CoverageSelectionRequest,
  RoadServiceObligation
} from "../../packages/road-coverage-planning-core/src/index.js";

const snapshot = {
  networkDatasetVersion: "dataset-v1",
  graphVersion: "graph-v1",
  travelProfileVersion: "travel-v1",
  costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`,
  costContentHash: `sha256:${"2".repeat(64)}`
} as const;
const area = { type: "Polygon" as const, coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };

class FixtureRepository implements CoverageSelectionRepository {
  constructor(readonly rows: CoverageSelectionCandidate[]) {}
  async select(): Promise<CoverageSelectionCandidate[]> { return structuredClone(this.rows); }
  async validateManual(_request: CoverageSelectionRequest, arcKeys: string[]): Promise<CoverageSelectionCandidate[]> {
    return structuredClone(this.rows.filter((row) => arcKeys.includes(row.arcKey)));
  }
}

function candidate(overrides: Partial<CoverageSelectionCandidate> = {}): CoverageSelectionCandidate {
  return {
    graphVersion: "graph-v1",
    edgeKey: `ed_${"a".repeat(64)}`,
    arcKey: `arc_${"a".repeat(64)}`,
    direction: "FORWARD",
    oneway: "BIDIRECTIONAL",
    startFractionPpm: 200_000,
    endFractionPpm: 600_000,
    requiredLengthMm: 40_000,
    roadClass: "LOCAL",
    sourceFeatureReferenceId: `wrf_${"a".repeat(32)}`,
    ...overrides
  };
}

function request(overrides: Partial<CoverageSelectionRequest> = {}): CoverageSelectionRequest {
  return {
    dataScopeKey: "scope-a",
    datasetScopeKey: "tenant-a",
    routingSnapshot: snapshot,
    area,
    maximumSelectionCandidates: 100,
    policy: {
      mode: "CLIPPED_INSIDE_AREA",
      roadClasses: ["LOCAL"],
      serviceMode: "BOTH_DIRECTIONS",
      requiredPasses: 1,
      minimumSegmentLengthMm: 0,
      selectionPolicyVersion: "coverage-selection/1.0"
    },
    ...overrides
  };
}

describe("road coverage area selection and obligation identity", () => {
  it("expands both legal arc directions into fixed obligations with oriented fractions", async () => {
    const rows = [
      candidate(),
      candidate({ arcKey: `arc_${"b".repeat(64)}`, direction: "REVERSE", startFractionPpm: 400_000, endFractionPpm: 800_000 })
    ];
    const result = await selectRoadServiceObligations(new FixtureRepository(rows), request());

    expect(result.obligationSet.obligationCount).toBe(2);
    expect(result.obligationSet.obligations.map((item) => item.serviceMode)).toEqual(["FIXED_DIRECTION", "FIXED_DIRECTION"]);
    expect(result.obligationSet.totalRequiredLengthMm).toBe(80_000);
    expect(validateContract("urn:gowm:v0.6:coverage-obligation-set", result.obligationSet)).toEqual({ valid: true, issues: [] });
  });

  it("uses an approved deterministic fixed-direction policy without inventing a reverse arc", async () => {
    const rows = [
      candidate({ arcKey: `arc_${"b".repeat(64)}`, direction: "REVERSE", startFractionPpm: 400_000, endFractionPpm: 800_000 }),
      candidate()
    ];
    const result = await selectRoadServiceObligations(new FixtureRepository(rows), request({
      policy: { ...request().policy, serviceMode: "FIXED_DIRECTION", fixedDirectionSource: "APPROVED_POLICY" }
    }));
    expect(result.obligationSet.obligations).toHaveLength(1);
    expect(result.obligationSet.obligations[0]?.arcKey).toBe(`arc_${"a".repeat(64)}`);
  });

  it("accepts a source-feature direction only when the source is authoritative", async () => {
    const fixed = request({
      policy: { ...request().policy, serviceMode: "FIXED_DIRECTION", fixedDirectionSource: "SOURCE_FEATURE_ATTRIBUTE" }
    });
    await expect(selectRoadServiceObligations(new FixtureRepository([candidate()]), fixed))
      .rejects.toMatchObject({ code: "INVALID_SELECTION_POLICY" });

    const legal = candidate({ oneway: "FORWARD_ONLY" });
    const result = await selectRoadServiceObligations(new FixtureRepository([legal]), fixed);
    expect(result.obligationSet.obligations).toHaveLength(1);
  });

  it("fails closed when fixed-direction authority is missing", async () => {
    const invalid = request({ policy: { ...request().policy, serviceMode: "FIXED_DIRECTION" } });
    await expect(selectRoadServiceObligations(new FixtureRepository([candidate()]), invalid))
      .rejects.toEqual(expect.objectContaining<Partial<CoveragePlanningError>>({ code: "INVALID_SELECTION_POLICY" }));
  });

  it("enforces the selection candidate budget before producing obligations", async () => {
    const rows = [candidate(), candidate({ arcKey: `arc_${"b".repeat(64)}` })];
    await expect(selectRoadServiceObligations(new FixtureRepository(rows), request({ maximumSelectionCandidates: 1 })))
      .rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });
  });

  it("uses an explicit DENY policy for empty selection", async () => {
    await expect(selectRoadServiceObligations(new FixtureRepository([]), request()))
      .rejects.toMatchObject({ code: "NO_OBLIGATIONS" });
  });

  it("validates and re-identifies manual obligations against the pinned graph", async () => {
    const row = candidate({ startFractionPpm: 0, endFractionPpm: 1_000_000, requiredLengthMm: 100_000 });
    const supplied = {
      obligationId: `obl_${"0".repeat(64)}`,
      graphVersion: "graph-v1",
      edgeKey: row.edgeKey,
      arcKey: row.arcKey,
      startFractionPpm: 100_000,
      endFractionPpm: 900_000,
      serviceMode: "FIXED_DIRECTION" as const,
      requiredPasses: 2,
      sourceFeatureReferenceKey: { namespace: "gowm" as const, kind: "LAYER_FEATURE" as const, id: row.sourceFeatureReferenceId, version: "dataset-v1" },
      selectionPolicyVersion: "coverage-selection/1.0",
      contentHash: `sha256:${"0".repeat(64)}`
    };
    const manualRequest = request({
      policy: {
        mode: "MANUAL_OBLIGATIONS",
        roadClasses: ["LOCAL"],
        serviceMode: "FIXED_DIRECTION",
        fixedDirectionSource: "MANUAL",
        requiredPasses: 2,
        minimumSegmentLengthMm: 0,
        manualObligations: [supplied]
      }
    });
    const result = await selectRoadServiceObligations(new FixtureRepository([row]), manualRequest);
    expect(result.obligationSet.obligations[0]?.obligationId).not.toBe(supplied.obligationId);
    expect(result.obligationSet.obligations[0]?.startFractionPpm).toBe(100_000);
  });

  it("retains area and feature ReferenceKeys in canonical identity", async () => {
    const areaReferenceKey = { namespace: "gowm" as const, kind: "LAYER_FEATURE" as const, id: `wrf_${"9".repeat(32)}`, version: "1" };
    const result = await selectRoadServiceObligations(new FixtureRepository([candidate()]), request({
      area: areaReferenceKey,
      resolvedArea: area
    }));
    expect(result.obligationSet.obligations[0]?.sourceAreaReferenceKey).toEqual(areaReferenceKey);
    expect(result.obligationSet.obligations[0]?.sourceFeatureReferenceKey.id).toMatch(/^wrf_/u);
  });

  it("produces stable obligation order and ledger hash independent of input order", async () => {
    const rows = [candidate(), candidate({ arcKey: `arc_${"b".repeat(64)}`, edgeKey: `ed_${"b".repeat(64)}` })];
    const left = await selectRoadServiceObligations(new FixtureRepository(rows), request());
    const right = await selectRoadServiceObligations(new FixtureRepository([...rows].reverse()), request());
    expect(left.obligationSet.obligations).toEqual(right.obligationSet.obligations);
    expect(obligationSetHash(left.obligationSet.obligations)).toBe(obligationSetHash(right.obligationSet.obligations));
  });

  it("canonicalizes arbitrary obligation rows by arc and fractions", () => {
    const obligations = [
      { arcKey: "arc_b", startFractionPpm: 0, endFractionPpm: 1, obligationId: "obl_b" },
      { arcKey: "arc_a", startFractionPpm: 2, endFractionPpm: 3, obligationId: "obl_a" }
    ] as RoadServiceObligation[];
    expect(canonicalObligationLedger(obligations).map((item) => item.obligationId)).toEqual(["obl_a", "obl_b"]);
  });
});
