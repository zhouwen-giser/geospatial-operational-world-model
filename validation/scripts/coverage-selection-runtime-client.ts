import pg from "pg";

import {
  CoveragePlanningError,
  PostgresCoverageSelectionRepository,
  selectRoadServiceObligations
} from "../../packages/road-coverage-planning-core/src/index.js";
import type {
  CoverageSelectionRequest,
  GeoJsonArea,
  RoadSelectionPolicy
} from "../../packages/road-coverage-planning-core/src/index.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const repository = new PostgresCoverageSelectionRepository({ pool, statementTimeoutMs: 15_000 });
const snapshot = {
  networkDatasetVersion: "dataset-v1",
  graphVersion: "graph-v1",
  travelProfileVersion: "travel-v1",
  costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`,
  costContentHash: `sha256:${"2".repeat(64)}`
} as const;
const polygonWithHole: GeoJsonArea = {
  type: "Polygon",
  coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
  ]
};

const checks: Record<string, boolean> = {};

function policy(overrides: Partial<RoadSelectionPolicy> = {}): RoadSelectionPolicy {
  return {
    mode: "CLIPPED_INSIDE_AREA",
    roadClasses: ["LOCAL"],
    serviceMode: "BOTH_DIRECTIONS",
    requiredPasses: 1,
    minimumSegmentLengthMm: 0,
    selectionPolicyVersion: "coverage-selection/1.0",
    ...overrides
  };
}

function request(area: GeoJsonArea, selectionPolicy: RoadSelectionPolicy, maximumSelectionCandidates = 100): CoverageSelectionRequest {
  return {
    dataScopeKey: "coverage-selection-runtime",
    datasetScopeKey: "tenant-a",
    routingSnapshot: snapshot,
    area,
    policy: selectionPolicy,
    maximumSelectionCandidates
  };
}

function check(name: string, condition: boolean, details?: unknown): void {
  if (!condition) throw new Error(`${name} failed${details === undefined ? "" : `: ${JSON.stringify(details)}`}`);
  checks[name] = true;
}

async function expectCode(name: string, expected: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    check(name, error instanceof CoveragePlanningError && error.code === expected, error);
    return;
  }
  throw new Error(`${name} unexpectedly succeeded`);
}

try {
  await expectCode("invalidPolygonRejected", "INVALID_AREA", async () => selectRoadServiceObligations(repository, request({
    type: "Polygon",
    coordinates: [[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]]]
  }, policy())));

  const clipped = await selectRoadServiceObligations(repository, request(polygonWithHole, policy()));
  const crossing = clipped.obligationSet.obligations.filter((item) => item.edgeKey === `ed_${"1".repeat(64)}`);
  check("polygonHoleAndMultipleClips", crossing.length === 4 &&
    new Set(crossing.map((item) => `${item.arcKey}:${item.startFractionPpm}:${item.endFractionPpm}`)).size === 4 &&
    new Set(crossing.map((item) => item.arcKey)).size === 2, crossing);
  check("roadClassFilter", clipped.obligationSet.obligations.every((item) => item.edgeKey !== `ed_${"6".repeat(64)}`));
  check("serviceEligibility", clipped.obligationSet.obligations.every((item) => item.edgeKey !== `ed_${"5".repeat(64)}`));

  const fully = await selectRoadServiceObligations(repository, request(polygonWithHole, policy({ mode: "FULLY_COVERED_EDGE" })));
  check("boundaryInclusiveCovers", fully.obligationSet.obligations.some((item) => item.edgeKey === `ed_${"4".repeat(64)}`));
  check("holeExcludesFullEdge", fully.obligationSet.obligations.every((item) => item.edgeKey !== `ed_${"1".repeat(64)}`));

  const complete = await selectRoadServiceObligations(repository, request(polygonWithHole, policy({ mode: "INTERSECTING_COMPLETE_EDGE" })));
  const completeCrossing = complete.obligationSet.obligations.filter((item) => item.edgeKey === `ed_${"1".repeat(64)}`);
  check("intersectingCompleteEdge", completeCrossing.length === 2 && completeCrossing.every((item) => item.startFractionPpm === 0 && item.endFractionPpm === 1_000_000));

  const oneWay = fully.obligationSet.obligations.filter((item) => item.edgeKey === `ed_${"2".repeat(64)}`);
  check("oneWayNoIllegalReverse", oneWay.length === 1 && oneWay[0]?.arcKey === `arc_${"3".repeat(64)}`, oneWay);
  const boundaryBoth = fully.obligationSet.obligations.filter((item) => item.edgeKey === `ed_${"4".repeat(64)}`);
  check("bothDirectionsExpanded", boundaryBoth.length === 2, boundaryBoth);

  const multipolygonA: GeoJsonArea = {
    type: "MultiPolygon",
    coordinates: [
      [[[0, 4], [2, 4], [2, 6], [0, 6], [0, 4]]],
      [[[8, 4], [10, 4], [10, 6], [8, 6], [8, 4]]]
    ]
  };
  const multipolygonB: GeoJsonArea = { type: "MultiPolygon", coordinates: [...multipolygonA.coordinates].reverse() };
  const multiA = await selectRoadServiceObligations(repository, request(multipolygonA, policy()));
  const multiB = await selectRoadServiceObligations(repository, request(multipolygonB, policy()));
  check("multipolygonDeterministic", multiA.obligationSet.obligationSetId === multiB.obligationSet.obligationSetId &&
    multiA.obligationSet.obligations.map((item) => item.obligationId).join() === multiB.obligationSet.obligations.map((item) => item.obligationId).join());

  await expectCode("minimumSegmentLengthDeny", "NO_OBLIGATIONS", async () => selectRoadServiceObligations(repository, request(
    multipolygonA,
    policy({ minimumSegmentLengthMm: 2_100_000 })
  )));
  await expectCode("candidateBudget", "RESOURCE_EXHAUSTED", async () => selectRoadServiceObligations(repository, request(
    polygonWithHole,
    policy(),
    1
  )));
  await expectCode("scopeFirst", "SCOPE_DENIED", async () => selectRoadServiceObligations(repository, {
    ...request(polygonWithHole, policy()),
    datasetScopeKey: "unauthorized"
  }));

  const manualSource = complete.obligationSet.obligations[0]!;
  const manual = await selectRoadServiceObligations(repository, {
    ...request(polygonWithHole, policy({
      mode: "MANUAL_OBLIGATIONS",
      serviceMode: "FIXED_DIRECTION",
      fixedDirectionSource: "MANUAL",
      manualObligations: [{ ...manualSource, startFractionPpm: 100_000, endFractionPpm: 900_000 }]
    }))
  });
  check("manualPinnedValidation", manual.obligationSet.obligations.length === 1 &&
    manual.obligationSet.obligations[0]?.startFractionPpm === 100_000 && manual.obligationSet.totalRequiredLengthMm > 0);

  process.stdout.write(`${JSON.stringify({ status: "PASS", checks, obligationCounts: {
    clipped: clipped.obligationSet.obligationCount,
    fullyCovered: fully.obligationSet.obligationCount,
    intersectingComplete: complete.obligationSet.obligationCount,
    multipolygon: multiA.obligationSet.obligationCount,
    manual: manual.obligationSet.obligationCount
  } })}\n`);
} finally {
  await pool.end();
}
