import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateContract, type CapabilityProviderManifest } from "../packages/platform/contract-runtime/src/index.js";
import { checkCrossCapability, checkSemanticRules, inspectTypeScript, operationKey, validateVocabularyExtension, type ImplementationEvidence } from "../packages/platform/semantic-conformance/src/index.js";
import { scanAndMaterialize, type ProviderSource } from "./materialize-capability-semantic-profiles.js";
import { syncWorldPlatformManifests } from "./sync-world-platform-manifests.js";

const root = resolve(dirnameOfSelf(), "..");
const output = process.env.GOWM_REPORT_DIRECTORY?.trim() || "reports/gowm-v0.6.2";
function dirnameOfSelf() { return fileURLToPath(new URL(".", import.meta.url)); }
export async function validateSemanticCatalog(requireBlackBox = true, write = false) {
  await scanAndMaterialize(root, true);
  await syncWorldPlatformManifests();
  const sources: ProviderSource[] = JSON.parse(await readFile(resolve(root, "validation/gowm-v0.6.2/provider-sources.json"), "utf8"));
  const manifests: CapabilityProviderManifest[] = await Promise.all(sources.map(async (s) => JSON.parse(await readFile(resolve(root, s.manifestPath), "utf8"))));
  const catalog = manifests.flatMap((m) => m.capabilities);
  const implementation = JSON.parse(await readFile(resolve(root, `${output}/semantic-implementation-report.json`), "utf8"));
  const evidence = new Map<string, ImplementationEvidence>(catalog.map((c) => [operationKey(c), implementation[operationKey(c)].evidence]));
  const issues = catalog.flatMap((c) => checkSemanticRules(c, evidence.get(operationKey(c))!, catalog, requireBlackBox));
  const frozen = JSON.parse(await readFile(resolve(root,"validation/gowm-v0.6.2/frozen-vocabulary-meanings.json"),"utf8"));
  for (const [name,baseline] of Object.entries(frozen)) {
    const current = JSON.parse(await readFile(resolve(root,"contracts/gowm-v0.6.2/vocabularies",name),"utf8"));
    for (const message of validateVocabularyExtension(baseline as Parameters<typeof validateVocabularyExtension>[0],current)) issues.push({rule:"VOCABULARY",operation:current.vocabularyId,message});
  }
  const cross = checkCrossCapability(catalog, evidence);
  issues.push(...cross);
  for (const manifest of manifests) if (!validateContract("urn:gowm:v0.6.2:capability-provider-manifest-v1.1", manifest).valid) issues.push({ rule: "MANIFEST", operation: manifest.provider.providerId, message: "Manifest 1.1 validation failed" });
  const gatewayPath = resolve(root, "services/gateway/world-capability-gateway/src/capability-semantics.ts");
  const gateway = inspectTypeScript(await readFile(gatewayPath, "utf8"), gatewayPath, root);
  const inference = gateway.symbols.some((s) => ["OVERRIDES", "domain", "profileFor"].includes(s)) || gateway.calls.some((c) => c.endsWith(".startsWith"));
  const leaks = catalog.filter((c) => /https?:\/\/|transportToken|providerEndpoint|containerName|SELECT\s.+FROM/iu.test(JSON.stringify(c.semanticProfile))).length;
  const counters = {
    semanticProfileMissing: catalog.filter((c) => !c.semanticProfile).length,
    semanticRuleViolation: issues.filter((i) => !["S009", "S014", "CROSS_CAPABILITY"].includes(i.rule)).length,
    semanticImplementationMismatch: issues.filter((i) => i.rule === "S009").length,
    crossCapabilityViolation: cross.length,
    stableCapabilityWithoutBlackBoxEvidence: catalog.filter((c) => c.maturity === "STABLE" && !evidence.get(operationKey(c))?.blackBox).length,
    runtimeSemanticInference: Number(inference), providerTopologyLeak: leaks,
    operationCollision: catalog.length - new Set(catalog.map(operationKey)).size
  };
  const applicableCounters = Object.entries(counters).filter(([name]) => requireBlackBox || name !== "stableCapabilityWithoutBlackBoxEvidence");
  const report = { schemaVersion: "1.0", counters, issues, status: applicableCounters.every(([, count]) => count === 0) ? "PASS" : "FAIL" };
  if (!validateContract("urn:gowm:v0.6.2:semantic-conformance-report", report).valid) throw new Error("Conformance report does not satisfy its contract");
  if (write) await writeFile(resolve(root, `${output}/semantic-conformance-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await validateSemanticCatalog(!process.argv.includes("--static-only"), process.argv.includes("--write"));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const relevant = Object.entries(report.counters).filter(([k]) => !(process.argv.includes("--static-only") && k === "stableCapabilityWithoutBlackBoxEvidence"));
  if (relevant.some(([,v]) => v !== 0)) process.exitCode = 1;
}
