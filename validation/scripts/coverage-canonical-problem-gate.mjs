import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateContract } from "../../dist/packages/platform/contract-runtime/src/index.js";
import {
  buildCanonicalCoverageProblem,
  buildRoadServiceObligation,
  coverageProblemHash,
  obligationSetHash
} from "../../dist/packages/road-coverage-planning-core/src/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V06_RUN_ID;
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("GOWM_V06_RUN_ID is invalid");
const snapshot = {
  networkDatasetVersion: "dataset-v1",
  graphVersion: "graph-v1",
  travelProfileVersion: "travel-v1",
  costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`,
  costContentHash: `sha256:${"2".repeat(64)}`
};
const feature = { namespace: "gowm", kind: "LAYER_FEATURE", id: `wrf_${"a".repeat(32)}`, version: "dataset-v1" };
const obligations = ["a", "b", "c"].map((hex, index) => buildRoadServiceObligation({
  routingSnapshot: snapshot,
  graphVersion: "graph-v1",
  edgeKey: `ed_${hex.repeat(64)}`,
  arcKey: `arc_${hex.repeat(64)}`,
  startFractionPpm: index * 100_000,
  endFractionPpm: 400_000 + index * 100_000,
  requiredPasses: index + 1,
  selectionPolicyVersion: "coverage-selection/1.0",
  sourceFeatureReferenceKey: feature
}));
const states = ["a", "b", "c"].map((hex, index) => ({
  arcKey: `arc_${hex.repeat(64)}`,
  fractionPpm: index * 100_000,
  direction: "FORWARD"
}));
const obligationPermutations = permutations(obligations);
const statePermutations = permutations(states);
const hashes = new Set();
const setHashes = new Set();
let contractValidations = 0;
for (const obligationRows of obligationPermutations) {
  setHashes.add(obligationSetHash(obligationRows));
  for (const entryStates of statePermutations) {
    const ledgerHash = obligationSetHash(obligationRows);
    const problem = buildCanonicalCoverageProblem({
      routingSnapshot: snapshot,
      startState: states[0],
      entryStates,
      exitStates: [...entryStates].reverse(),
      endpointMode: "RETURN_TO_START",
      boundaryCrossingPolicy: "FREE",
      obligationSet: {
        schemaVersion: "1.0",
        obligationSetId: `obls_${ledgerHash.slice("sha256:".length)}`,
        routingSnapshot: snapshot,
        selectionMode: "CLIPPED_INSIDE_AREA",
        obligations: obligationRows,
        obligationCount: obligationRows.length,
        totalRequiredLengthMm: 1_200_000,
        selectionReceiptHash: `sha256:${"3".repeat(64)}`,
        warnings: []
      },
      objective: { weights: { distance: 1_000_000, duration: 0 }, profile: "LEAST_DEADHEAD" },
      budgets: { maximumMatrixCells: 1024, maximumCandidates: 8, timeLimitMs: 10_000 }
    });
    if (coverageProblemHash(problem) !== problem.problemHash) throw new Error("problem self-hash mismatch");
    const validation = validateContract("urn:gowm:v0.6:coverage-problem", problem);
    if (!validation.valid) throw new Error(`canonical problem contract failure: ${JSON.stringify(validation.issues)}`);
    contractValidations += 1;
    hashes.add(problem.problemHash);
  }
}
if (setHashes.size !== 1 || hashes.size !== 1) {
  throw new Error(`canonical hash changed across permutations: sets=${setHashes.size} problems=${hashes.size}`);
}
const evidence = {
  schemaVersion: "1.0",
  runId,
  status: "PASS",
  obligationPermutations: obligationPermutations.length,
  statePermutations: statePermutations.length,
  combinations: obligationPermutations.length * statePermutations.length,
  contractValidations,
  obligationSetHash: [...setHashes][0],
  problemHash: [...hashes][0]
};
const reportDirectory = resolve(repositoryRoot, "reports/gowm-v0.6");
await mkdir(reportDirectory, { recursive: true });
await writeFile(resolve(reportDirectory, `b01-canonical-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`GOWM_COVERAGE_CANONICAL_PROBLEM_PASS ${runId} combinations=${evidence.combinations}\n`);

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) => permutations(values.filter((_, itemIndex) => itemIndex !== index))
    .map((tail) => [value, ...tail]));
}
