import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSha256, validateContract, type CapabilityDescriptor } from "../packages/platform/contract-runtime/src/index.js";
import { projectCapabilitySemantics } from "../services/gateway/world-capability-gateway/src/capability-semantics.js";
import { buildWorldPlatformRegistry } from "./build-world-platform-registry.js";
import { validateSemanticCatalog } from "./validate-semantic-catalog.js";

export function createSouthboundOperationLock(catalog: readonly CapabilityDescriptor[], contractCatalogRevision: string, stableAdmissionPassed: boolean) {
  if (catalog.some((c) => !c.semanticProfile)) throw new Error("Cannot lock an operation with missing explicit semantics");
  const project = (c: CapabilityDescriptor) => ({ operationId:c.operationId,operationVersion:c.operationVersion,inputSchemaHash:c.inputSchemaHash,outputSchemaHash:c.outputSchemaHash,semanticProfileHash:canonicalSha256(c.semanticProfile!),maturity:c.maturity });
  const ordered = [...catalog].sort((a,b) => `${a.operationId}@${a.operationVersion}`.localeCompare(`${b.operationId}@${b.operationVersion}`));
  const lock = { schemaVersion:"1.0",gatewayContractVersion:"0.6.2",contractCatalogRevision,
    semanticCatalogHash:projectCapabilitySemantics(ordered,contractCatalogRevision).catalogHash,
    defaultOperations:stableAdmissionPassed ? ordered.filter((c) => c.maturity === "STABLE").map(project) : [],
    previewOperations:ordered.filter((c) => c.maturity === "PREVIEW").map(project)
  };
  if (!validateContract("urn:gowm:v0.6.2:wsgs-southbound-operation-lock",lock).valid) throw new Error("Invalid consumer operation lock");
  if (/https?:\/\/|transportToken|approvalId|providerId|containerName|SELECT\s.+FROM/iu.test(JSON.stringify(lock))) throw new Error("Consumer lock leaks deployment metadata");
  return lock;
}
export async function generateSouthboundOperationLock(write = false, allowPending = false) {
  const registry = await buildWorldPlatformRegistry();
  const conformance = await validateSemanticCatalog(true, false);
  const staticCounters = Object.entries(conformance.counters).filter(([k]) => k !== "stableCapabilityWithoutBlackBoxEvidence");
  if (staticCounters.some(([,v]) => v !== 0) || conformance.status !== "PASS" && !allowPending) throw new Error("All applicable semantic gates are required for the consumer lock");
  const lock = createSouthboundOperationLock(registry.catalog,registry.report.contractCatalogRevision,conformance.status === "PASS");
  const path = "contracts/consumers/wsgs-southbound-operation-lock-v1.json", bytes=`${JSON.stringify(lock,null,2)}\n`;
  if (write) { await mkdir("contracts/consumers",{recursive:true}); await writeFile(path,bytes); }
  else if (await readFile(path,"utf8").catch(() => "") !== bytes) throw new Error("Stale generated consumer lock");
  return {status:conformance.status === "PASS" ? "PASS" : "PENDING_STABLE_EVIDENCE",defaultOperations:lock.defaultOperations.length,previewOperations:lock.previewOperations.length,lockHash:canonicalSha256(lock)};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await generateSouthboundOperationLock(process.argv.includes("--write"),process.argv.includes("--allow-pending")))}\n`);
}
