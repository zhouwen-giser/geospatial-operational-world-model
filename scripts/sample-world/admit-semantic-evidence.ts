import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSha256, validateAgainstSchema } from "../../packages/platform/contract-runtime/src/index.js";
import { semanticSourceFingerprint } from "../../packages/platform/semantic-conformance/src/index.js";
import { realizeSampleWorld } from "./model.js";
import { probeLiveSampleInstance } from "./readiness.js";
import {
  ensureSampleRuntimeEnvironment,
  sampleGatewayBaseUrl,
  type SampleRuntimeEnvironment
} from "./runtime.js";

type AnyRecord = Record<string, any>;

const PROMOTED_OPERATIONS = [
  "reference.get",
  "reference.resolve",
  "world.get-current-state",
  "world.get-geometry",
  "world.get-provenance",
  "catalog.get",
  "catalog.search",
  "spatial.find-nearby",
  "spatial.find-in-area",
  "spatial.find-intersections"
] as const;

export async function admitSampleSemanticEvidence(
  runtimeOrRoot: SampleRuntimeEnvironment | string = process.cwd()
): Promise<string> {
  const runtimeEnvironment = typeof runtimeOrRoot === "string"
    ? await ensureSampleRuntimeEnvironment(resolve(runtimeOrRoot))
    : runtimeOrRoot;
  const root = runtimeEnvironment.paths.root;
  const runtime = runtimeEnvironment.paths;
  const reportRoot = resolve(root, "reports/gowm-v0.6.3");
  const canary = await readJson(resolve(runtime.outputDirectory, "CANARY_EVIDENCE_REPORT.json"));
  const canarySchema = await readJson(resolve(
    root,
    "contracts/wsgs-sample-world/v1/sample-world-canary-evidence-report.schema.json"
  ));
  const canaryValidation = validateAgainstSchema(canarySchema, canary, {
    schemaName: "sample-world-canary-evidence-report.schema.json"
  });
  if (!canaryValidation.valid) {
    throw new Error(`Canary evidence contract mismatch: ${JSON.stringify(canaryValidation.issues)}`);
  }
  const realization = await realizeSampleWorld({
    epoch: runtimeEnvironment.values.SAMPLE_WORLD_EPOCH!,
    seed: runtimeEnvironment.values.SAMPLE_WORLD_SEED!
  });
  const live = await probeLiveSampleInstance(runtimeEnvironment, { expectedRevision: "v1" });
  const implementation = await readJson(resolve(reportRoot, "semantic-implementation-report.json"));
  const baseUrl = sampleGatewayBaseUrl(runtimeEnvironment, {});
  const [catalogResponse, semanticsResponse] = await Promise.all([
    fetch(`${baseUrl}/v1/capabilities`, { signal: AbortSignal.timeout(30_000) }),
    fetch(`${baseUrl}/v1/capability-semantics`, { signal: AbortSignal.timeout(30_000) })
  ]);
  if (!catalogResponse.ok || !semanticsResponse.ok) throw new Error("Live Gateway contract discovery failed");
  const catalog = await catalogResponse.json() as AnyRecord;
  const semantics = await semanticsResponse.json() as AnyRecord;
  const currentSourceDigest = await semanticSourceFingerprint(root);

  if (canary.status !== "PASS" || canary.sourceDigest !== currentSourceDigest) {
    throw new Error("Canary evidence is missing, failed or stale for the current semantic sources");
  }
  if (canary.fixtureHash !== realization.fixture.sourceFixtureHash ||
      canary.realizationId !== realization.fixture.realizationId ||
      canary.realizationId !== live.realizationId ||
      canary.loadedStateHash !== live.loadedStateHash) {
    throw new Error("Canary fixture, realization or loaded-state identity differs from the live v1 instance");
  }
  if (canary.contractCatalogRevision !== catalog.contractCatalogRevision ||
      canary.contractCatalogRevision !== semantics.contractCatalogRevision ||
      canary.semanticCatalogHash !== semantics.catalogHash) {
    throw new Error("Canary and live contract/semantic revisions differ");
  }
  if (!/^sample-realization-[0-9a-f-]+$/u.test(String(canary.realizationId)) ||
      !/^[0-9a-f]{64}$/u.test(String(canary.loadedStateHash))) {
    throw new Error("Canary is missing its live realization or loaded-state identity");
  }

  const cases = canary.cases as AnyRecord[];
  const mapping = canary.promotedOperationPassCases as Array<{
    operationId?: string;
    operationVersion?: string;
    caseId?: string;
  }>;
  const operations: Record<string, unknown> = {};
  for (const operationId of PROMOTED_OPERATIONS) {
    const descriptor = (catalog.capabilities as AnyRecord[] | undefined)?.find((candidate) =>
      candidate.operationId === operationId && candidate.operationVersion === "1.0"
    );
    if (!descriptor || descriptor.maturity !== "STABLE") {
      throw new Error(`Live promoted operation is not Stable: ${operationId}@1.0`);
    }
    const testIds = (Array.isArray(mapping) ? mapping : [])
      .filter((entry) => entry.operationId === operationId && entry.operationVersion === "1.0")
      .map((entry) => entry.caseId)
      .filter((caseId): caseId is string => typeof caseId === "string" && caseId.length > 0);
    if (testIds.length === 0) {
      throw new Error(`Canary has no positive mapping for ${operationId}@1.0`);
    }
    for (const caseId of testIds) {
      const evidence = cases.find((candidate) => candidate.caseId === caseId && candidate.operationId === operationId);
      if (!evidence || evidence.status !== "PASS" || evidence.operationVersion !== "1.0" ||
          evidence.normalizedStatus !== "COMPLETED" ||
          !/^sha256:[0-9a-f]{64}$/u.test(String(evidence.inputHash)) ||
          !/^sha256:[0-9a-f]{64}$/u.test(String(evidence.outputHash)) ||
          !Object.hasOwn(evidence, "dataSnapshot") || !Object.hasOwn(evidence, "computeSnapshot") ||
          !Array.isArray(evidence.receipts) || evidence.receipts.length === 0 ||
          !Array.isArray(evidence.evidenceReferences) ||
          typeof evidence.elapsedMs !== "number" || evidence.elapsedMs < 0) {
        throw new Error(`Canary case ${caseId} lacks complete Gateway envelope evidence for ${operationId}`);
      }
    }
    const evidenceDigest = implementation[`${operationId}@1.0`]?.operationEvidenceDigest;
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(evidenceDigest))) {
      throw new Error(`Implementation report lacks an operation evidence digest for ${operationId}`);
    }
    operations[`${operationId}@1.0`] = {
      status: "PASS",
      sourceDigest: currentSourceDigest,
      contractHash: canonicalSha256(descriptor),
      evidenceDigest,
      tests: [...testIds].sort()
    };
  }

  const receipt = {
    status: "PASS",
    sourceDigest: currentSourceDigest,
    runId: `${canary.realizationId}-sample-canary`,
    evidence: {
      canaryPath: relative(
        root,
        resolve(runtime.outputDirectory, "CANARY_EVIDENCE_REPORT.json")
      ).replaceAll("\\", "/"),
      canaryHash: canonicalSha256(canary),
      realizationId: canary.realizationId,
      loadedStateHash: canary.loadedStateHash,
      contractCatalogRevision: canary.contractCatalogRevision,
      semanticCatalogHash: canary.semanticCatalogHash
    },
    operations
  };
  await writeFile(resolve(reportRoot, "black-box-evidence.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`SAMPLE_WORLD_SEMANTIC_EVIDENCE_ADMITTED operations=${PROMOTED_OPERATIONS.length} sourceDigest=${currentSourceDigest}\n`);
  return currentSourceDigest;
}

async function readJson(path: string): Promise<AnyRecord> {
  return JSON.parse(await readFile(path, "utf8")) as AnyRecord;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  admitSampleSemanticEvidence().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
