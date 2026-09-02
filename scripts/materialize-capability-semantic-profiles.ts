import { execFileSync } from "node:child_process";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, canonicalSha256, compareCanonicalJson, compareUnicodeCodePoints, validateContract, type CapabilityDescriptor, type CapabilityProviderManifest } from "../packages/platform/contract-runtime/src/index.js";
import { byteHash, inspectSchema, inspectSql, inspectTypeScript, materializeProfile, operationKey, semanticSourceFingerprint, type ImplementationEvidence, type SemanticProfile } from "../packages/platform/semantic-conformance/src/index.js";
import { buildSpatialQuery } from "../services/providers/spatial-provider-bridge/src/sql.js";
import type { SpatialOperationId } from "../services/providers/spatial-provider-bridge/src/schemas.js";

export interface SourceEvidence { path: string; symbol?: string }
export interface OperationDeclaration {
  profile: SemanticProfile;
  implementation: SourceEvidence[];
  tests: string[];
  bridgeLocks?: string[];
  referenceAuthorities?: string[];
  sqlProbe?: { input: unknown; functions: string[] };
  exactAlgorithm?: SourceEvidence[];
  candidateOnly?: boolean;
  distance?: { unit: "METERS"; model: "WGS84_GEOGRAPHY_SPHEROID" };
  verificationMapping?: { retainedInput: string; targetInput: string; explanation: string };
  rationale: string;
}
export interface ProviderSource { providerId: string; manifestPath: string; aliases?: string[]; declarationPath: string; generatedPath: string }
export interface OperationEvidenceRecord { kind: string; path: string; sha256: string; symbol?: string }
export interface BlackBoxReceipt {
  status?: string;
  sourceDigest?: string;
  contractHash?: string;
  evidenceDigest?: string;
  tests?: unknown[];
}
export interface LegacySemanticAttestation {
  status?: string;
  evidence?: OperationEvidenceRecord[];
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.GOWM_REPORT_DIRECTORY?.trim() || "reports/gowm-v0.7.1/pr-b/world-platform";
const preserveHistoricalReports = process.argv.includes("--preserve-historical-reports");
const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, "utf8"));
const render = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const portablePath = (path: string): string => path.replaceAll("\\", "/");
const canonicalTextBytes = (bytes: Buffer): Buffer => Buffer.from(bytes.toString("utf8").replace(/\r\n/gu, "\n"), "utf8");

export function generatedTextMatches(actual: string, expected: string): boolean {
  return actual.replace(/\r\n/gu, "\n") === expected.replace(/\r\n/gu, "\n");
}

export function operationEvidenceDigest(records: readonly OperationEvidenceRecord[]): string {
  const normalized = records
    .filter((record) => record.kind !== "BLACK_BOX_TEST")
    .map((record) => ({
      kind: record.kind,
      path: portablePath(record.path),
      sha256: record.sha256,
      ...(record.symbol ? { symbol: record.symbol } : {})
    }))
    .sort(compareCanonicalJson);
  return canonicalSha256(normalized);
}

export function isCurrentBlackBoxReceipt(input: {
  reportStatus?: string;
  reportSourceDigest?: string;
  receipt?: BlackBoxReceipt | undefined;
  contractHash: string;
  evidenceDigest: string;
  legacyAttestation?: LegacySemanticAttestation | undefined;
}): boolean {
  const { receipt } = input;
  if (
    input.reportStatus !== "PASS" ||
    typeof input.reportSourceDigest !== "string" ||
    receipt?.status !== "PASS" ||
    receipt.contractHash !== input.contractHash ||
    !Array.isArray(receipt.tests) ||
    receipt.tests.length === 0 ||
    receipt.sourceDigest !== input.reportSourceDigest
  ) return false;
  if (typeof receipt.evidenceDigest === "string") return receipt.evidenceDigest === input.evidenceDigest;
  return input.legacyAttestation?.status === "PROVEN" &&
    Array.isArray(input.legacyAttestation.evidence) &&
    operationEvidenceDigest(input.legacyAttestation.evidence) === input.evidenceDigest;
}

function readCommittedAttestations(repositoryRoot: string, paths: readonly string[]): Map<string, LegacySemanticAttestation> {
  const attestations = new Map<string, LegacySemanticAttestation>();
  if (paths.length === 0) return attestations;
  try {
    const input = `${paths.map((path) => `HEAD:${portablePath(path)}`).join("\n")}\n`;
    const batch = execFileSync("git", ["cat-file", "--batch"], { cwd: repositoryRoot, input, maxBuffer: 32 * 1024 * 1024 });
    let offset = 0;
    for (const path of paths) {
      const lineEnd = batch.indexOf(0x0a, offset);
      if (lineEnd < 0) break;
      const header = batch.subarray(offset, lineEnd).toString("utf8");
      offset = lineEnd + 1;
      if (header.endsWith(" missing")) continue;
      const size = Number(header.split(" ").at(-1));
      if (!Number.isSafeInteger(size) || size < 0 || offset + size > batch.length) break;
      try {
        attestations.set(path, JSON.parse(batch.subarray(offset, offset + size).toString("utf8")) as LegacySemanticAttestation);
      } catch {
        // A malformed or unavailable legacy attestation is deliberately fail-closed.
      }
      offset += size;
      if (batch[offset] === 0x0a) offset += 1;
    }
  } catch {
    // Legacy migration is optional. New evidence-digest receipts remain usable without Git history.
  }
  return attestations;
}

async function files(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((e) => e.isDirectory() ? files(resolve(path, e.name)) : [resolve(path, e.name)]))).flat().sort();
}

export async function scanAndMaterialize(repositoryRoot = root, check = true) {
  const sources: ProviderSource[] = await readJson(resolve(repositoryRoot, "validation/gowm-v0.6.2/provider-sources.json"));
  const authorities = await readJson(resolve(repositoryRoot, "contracts/gowm-v0.6.2/provider-semantic-authority-map.v1.json"));
  const rules = await readJson(resolve(repositoryRoot, "contracts/gowm-v0.6.2/rules/capability-semantic-rules.v1.json"));
  if (rules.resolutionPolicy.humanConfirmationAllowed !== false || rules.rules.length !== 14) throw new Error("Invalid rules authority");
  const schemaDocs = new Map<string, any>(), byId = new Map<string, any>(), locations = new WeakMap<object, string>();
  for (const path of await files(resolve(repositoryRoot, "contracts"))) {
    if (!path.endsWith(".schema.json")) continue;
    const document = await readJson(path);
    schemaDocs.set(path, document);
    const locate = (value: any): void => {
      if (!value || typeof value !== "object") return;
      locations.set(value, path);
      if (typeof value.$id === "string") byId.set(value.$id, value);
      Object.values(value).forEach(locate);
    };
    locate(document);
  }
  const resolveSchema = (ref: string, parent?: unknown): any => {
    const [doc = "", fragment = ""] = ref.split("#");
    let schema = byId.get(doc);
    if (!schema) {
      const parentPath = parent && typeof parent === "object" ? locations.get(parent) : undefined;
      const path = doc ? resolve(parentPath ? dirname(parentPath) : repositoryRoot, doc) : parentPath;
      schema = path ? schemaDocs.get(path) : undefined;
    }
    if (!schema) throw new Error(`Unresolved schema ${ref}`);
    for (const token of fragment.split("/").filter(Boolean)) schema = schema[token.replaceAll("~1", "/").replaceAll("~0", "~")];
    if (!schema) throw new Error(`Unresolved schema fragment ${ref}`);
    return schema;
  };
  const declarations = new Map<string, OperationDeclaration>(), manifests = new Map<string, CapabilityProviderManifest>();
  for (const source of sources) {
    const manifest: CapabilityProviderManifest = await readJson(resolve(repositoryRoot, source.manifestPath));
    if (manifest.provider.providerId !== source.providerId) throw new Error(`Provider source identity mismatch: ${source.providerId}`);
    manifests.set(source.providerId, manifest);
    const declared = await readJson(resolve(repositoryRoot, source.declarationPath));
    for (const c of manifest.capabilities) {
      const op = operationKey(c);
      if (declarations.has(op)) throw new Error(`Duplicate operation ${op}`);
      if (declared.operations[op]) declarations.set(op, declared.operations[op]);
    }
    const actual = new Set(manifest.capabilities.map(operationKey));
    for (const op of Object.keys(declared.operations)) if (!actual.has(op)) throw new Error(`Orphan semantic declaration ${op}`);
  }
  const catalog = [...manifests.values()].flatMap((m) => m.capabilities.map((c) => ({ ...c, ...(declarations.get(operationKey(c)) ? { semanticProfile: declarations.get(operationKey(c))!.profile } : {}) })));
  const blackBoxPath = `${output}/black-box-evidence.json`;
  const blackBoxBytes = await readFile(resolve(repositoryRoot, blackBoxPath)).catch(() => undefined);
  const blackBox = blackBoxBytes ? JSON.parse(blackBoxBytes.toString("utf8")) : { operations: {} };
  const currentSourceDigest = await semanticSourceFingerprint(repositoryRoot);
  const blackBoxSourceIsCurrent = blackBox.sourceDigest === currentSourceDigest;
  const attestationPaths = [...manifests.values()].flatMap((manifest) => manifest.capabilities.map((descriptor) =>
    `${output}/semantic-attestations/${operationKey(descriptor)}.json`
  ));
  const committedAttestations = readCommittedAttestations(repositoryRoot, attestationPaths);
  const resolved: string[] = [], conflicts: object[] = [], insufficient: object[] = [];
  const artifacts = new Map<string, string>();
  const implementationReport: Record<string, unknown> = {};
  const attestations: any[] = [];
  const pendingAdmission = new Map<string, {
    contractHash: string;
    descriptor: CapabilityDescriptor;
    evidence: ImplementationEvidence;
    implementationEntry: Record<string, unknown>;
    rationale: string;
    receipt?: BlackBoxReceipt | undefined;
    legacyAttestation?: LegacySemanticAttestation | undefined;
  }>();
  for (const source of [...sources].sort((a, b) => compareUnicodeCodePoints(a.providerId, b.providerId))) {
    const manifest = manifests.get(source.providerId)!;
    const generated: Record<string, SemanticProfile> = {};
    const authority = authorities.authorities.find((a: any) => a.providerId === source.providerId);
    for (const descriptor of [...manifest.capabilities].sort((a, b) => compareUnicodeCodePoints(operationKey(a), operationKey(b)))) {
      const op = operationKey(descriptor), declaration = declarations.get(op);
      const evidenceRecords: OperationEvidenceRecord[] = [];
      const record = async (kind: string, path: string, symbol?: string) => {
        const normalizedPath = portablePath(path);
        const bytes = await readFile(resolve(repositoryRoot, normalizedPath));
        evidenceRecords.push({ kind, path: normalizedPath, sha256: byteHash(canonicalTextBytes(bytes)), ...(symbol ? { symbol } : {}) });
        return bytes.toString();
      };
      await record("DESCRIPTOR", source.manifestPath);
      await record("PORTS", source.manifestPath);
      const input = resolveSchema(descriptor.inputSchemaUri), result = resolveSchema(descriptor.outputSchemaUri);
      for (const [kind, schema] of [["INPUT_SCHEMA", input], ["OUTPUT_SCHEMA", result]] as const) {
        const path = portablePath(relative(repositoryRoot, locations.get(schema)!));
        await record(kind, path);
        const expected = kind === "INPUT_SCHEMA" ? descriptor.inputSchemaHash : descriptor.outputSchemaHash;
        const rawBytes = await readFile(resolve(repositoryRoot, path));
        const rawHash = `sha256:${byteHash(canonicalTextBytes(rawBytes))}`;
        if (expected !== canonicalSha256(schema) && expected !== rawHash) conflicts.push({ operation: op, reason: `${kind} hash mismatch` });
      }
      const inputShape = inspectSchema(input, resolveSchema), outputShape = inspectSchema(result, resolveSchema);
      let implementation = Boolean(declaration?.implementation.length && declaration.tests.length);
      const inspections: { path: string; inspection: ReturnType<typeof inspectTypeScript> }[] = [];
      for (const item of declaration?.implementation ?? []) {
        const text = await record("TYPESCRIPT_IMPLEMENTATION", item.path, item.symbol);
        const inspection = inspectTypeScript(text, resolve(repositoryRoot, item.path), repositoryRoot);
        inspections.push({ path: item.path, inspection });
        if (inspection.diagnostics || inspection.siblingImports.length || item.symbol && !inspection.symbols.includes(item.symbol)) implementation = false;
      }
      for (const path of declaration?.tests ?? []) await record("UNIT_TEST", path);
      for (const path of declaration?.referenceAuthorities ?? []) {
        const source = await record(path.endsWith(".sql") ? "SQL_IMPLEMENTATION" : "TYPESCRIPT_IMPLEMENTATION", path);
        if (path.endsWith(".sql")) await inspectSql(source);
        else if (inspectTypeScript(source, resolve(repositoryRoot,path), repositoryRoot).diagnostics) implementation = false;
      }
      for (const path of declaration?.bridgeLocks ?? []) {
        const lock = JSON.parse(await record("SOURCE_LOCK", path));
        if (!lock.sourceGitCommit && !lock.sourceZipSha256 && !lock.sourceZipDigest && !lock.sourceZip && !lock.sourceKind) implementation = false;
      }
      let sql: Awaited<ReturnType<typeof inspectSql>> | undefined;
      if (declaration?.sqlProbe) {
        const query = buildSpatialQuery(descriptor.operationId as SpatialOperationId, declaration.sqlProbe.input, undefined, { maximumRows: 10_000, maximumCandidates: 50_000, maximumEvidenceReferences: 1000 });
        sql = await inspectSql(query.text);
        await record("SQL_IMPLEMENTATION", "services/providers/spatial-provider-bridge/src/sql.ts", "buildSpatialQuery");
        if (declaration.sqlProbe.functions.some((f) => !sql!.functions.includes(f))) implementation = false;
      }
      let exactAlgorithm = Boolean(declaration?.exactAlgorithm?.length);
      for (const item of declaration?.exactAlgorithm ?? []) {
        const text = await record("TYPESCRIPT_IMPLEMENTATION", item.path, item.symbol);
        const inspection = inspectTypeScript(text, resolve(repositoryRoot, item.path), repositoryRoot);
        if (!item.symbol || !inspection.symbols.includes(item.symbol) || inspection.diagnostics) exactAlgorithm = false;
      }
      const primaryStatuses = outputShape.statusPaths[declaration?.profile.domainStatus?.path ?? "/status"] ?? [];
      const receipt = blackBox.operations[op];
      const contractHash = canonicalSha256({ ...descriptor, semanticProfile: declaration?.profile ?? null });
      const evidence: ImplementationEvidence = {
        referenceInput: inputShape.referencePaths.length > 0 || descriptor.ports.inputs.some((p) => p.valueKind === "REFERENCE_KEY"),
        referenceOutput: outputShape.referencePaths.length > 0 || descriptor.ports.outputs.some((p) => p.valueKind === "REFERENCE_KEY"),
        outputFeatures: outputShape.paths.map((p) => p.split("/").at(-1)!), domainStatuses: primaryStatuses,
        exactSpatial: sql?.exact === true || exactAlgorithm,
        candidateOnly: declaration?.candidateOnly === true || sql?.bboxOnly === true,
        distanceUnit: declaration?.distance?.unit === "METERS" && inputShape.paths.some((p) => ["/radiusM", "/maxDistanceM", "/distanceM"].includes(p)),
        distanceModel: declaration?.distance?.model === "WGS84_GEOGRAPHY_SPHEROID" && sql?.geographyDistance === true,
        implementation, blackBox: false, verificationPorts: false
      };
      if (declaration?.verificationMapping && declaration.profile.exactVerification) {
        const target = catalog.find((c) => operationKey(c) === operationKey(declaration.profile.exactVerification!));
        if (target) {
          const targetShape = inspectSchema(resolveSchema(target.inputSchemaUri), resolveSchema);
          const retained=inputShape.geometryTypes[declaration.verificationMapping.retainedInput]??[];
          const accepted=targetShape.geometryTypes[declaration.verificationMapping.targetInput]??[];
          evidence.verificationPorts = retained.length>0 && retained.every((type)=>accepted.includes(type));
        }
      }
      const implementationEntry: Record<string, unknown> = { contractHash, inputShape, outputShape, evidence, ...(sql ? { sql } : {}), inspections: inspections.map(({ path, inspection }) => ({ path, symbols: inspection.symbols, calls: inspection.calls, siblingImports: inspection.siblingImports, diagnostics: inspection.diagnostics })) };
      implementationReport[op] = implementationEntry;
      const outcome = materializeProfile({ descriptor, ...(declaration ? { declaration: declaration.profile } : {}), evidence, catalog });
      if (declaration && !authority?.allowedDomains.includes(declaration.profile.domain)) outcome.issues.push({ rule: "AUTHORITY", operation: op, message: "Domain outside explicit provider authority" });
      if (outcome.status !== "RESOLVED" || outcome.issues.length) {
        (outcome.status === "INSUFFICIENT_CONTRACT" ? insufficient : conflicts).push({ operation: op, issues: outcome.issues });
        continue;
      }
      resolved.push(op); generated[op] = outcome.profile!;
      descriptor.semanticProfile = outcome.profile!;
      const attestation = {
        schemaVersion: "1.0", providerId: source.providerId, operationId: descriptor.operationId, operationVersion: descriptor.operationVersion,
        semanticProfileHash: outcome.profileHash,
        rulesApplied: rules.rules.map((r: any) => r.id), evidence: evidenceRecords,
        status: descriptor.maturity === "STABLE" ? "BLOCKED" : "PROVEN",
        notes: [declaration!.rationale]
      };
      attestations.push(attestation);
      pendingAdmission.set(op, {
        contractHash,
        descriptor,
        evidence,
        implementationEntry,
        rationale: declaration!.rationale,
        receipt,
        legacyAttestation: committedAttestations.get(`${output}/semantic-attestations/${op}.json`)
      });
    }
    artifacts.set(source.generatedPath, render(generated));
    manifest.manifestSchemaVersion = "1.1";
    artifacts.set(source.manifestPath, render(manifest));
    for (const alias of source.aliases ?? []) artifacts.set(alias, render(manifest));
  }
  // Rebind descriptor/ports byte evidence to the final manifest; otherwise pass two would differ.
  for (const attestation of attestations) {
    for (const record of attestation.evidence) if (artifacts.has(record.path)) record.sha256 = byteHash(artifacts.get(record.path)!);
    const op = `${attestation.operationId}@${attestation.operationVersion}`;
    const pending = pendingAdmission.get(op)!;
    const evidenceDigest = operationEvidenceDigest(attestation.evidence);
    const currentBlackBox = isCurrentBlackBoxReceipt({
      reportStatus: blackBoxSourceIsCurrent ? blackBox.status : "STALE",
      reportSourceDigest: currentSourceDigest,
      receipt: pending.receipt,
      contractHash: pending.contractHash,
      evidenceDigest,
      legacyAttestation: pending.legacyAttestation
    });
    pending.evidence.blackBox = currentBlackBox;
    pending.implementationEntry.operationEvidenceDigest = evidenceDigest;
    if (currentBlackBox && blackBoxBytes) {
      attestation.evidence.push({
        kind: "BLACK_BOX_TEST",
        path: blackBoxPath,
        sha256: byteHash(canonicalTextBytes(blackBoxBytes)),
        symbol: op
      });
    }
    attestation.status = pending.descriptor.maturity === "STABLE" && !currentBlackBox ? "BLOCKED" : "PROVEN";
    attestation.notes = [
      pending.rationale,
      ...(pending.descriptor.maturity === "STABLE" && !currentBlackBox
        ? ["Static profile resolved; current real black-box execution remains required for Stable admission."]
        : [])
    ];
    if (!validateContract("urn:gowm:v0.6.2:semantic-attestation", attestation).valid) throw new Error(`Invalid attestation ${op}`);
    artifacts.set(`${output}/semantic-attestations/${op}.json`, render(attestation));
  }
  const report = { schemaVersion: "1.0", resolved: resolved.sort(), conflicts, insufficient,
    determinismHash: canonicalSha256({ declarations: [...declarations].sort(([a], [b]) => compareUnicodeCodePoints(a, b)), profiles: catalog.map((c) => ({ operation: operationKey(c), profile: c.semanticProfile ?? null })).sort((a,b) => compareUnicodeCodePoints(a.operation, b.operation)), attestations }),
    status: conflicts.length || insufficient.length ? "FAIL" : "PASS" };
  if (report.status === "FAIL") {
    if (!check) { await mkdir(resolve(repositoryRoot, output), { recursive: true }); await writeFile(resolve(repositoryRoot, `${output}/semantic-materializer-report.json`), render(report)); }
    throw new Error(`Semantic materialization failed: ${canonicalJson({ conflicts, insufficient })}`);
  }
  artifacts.set(`${output}/semantic-materializer-report.json`, render(report));
  artifacts.set(`${output}/semantic-implementation-report.json`, render(implementationReport));
  const stale: string[] = [];
  for (const [path, content] of artifacts) {
    if (check) {
      const actual = await readFile(resolve(repositoryRoot, path), "utf8").catch(() => "");
      const historicalOutput = path === output || path.startsWith(`${output}/`);
      if (!generatedTextMatches(actual, content) && !(preserveHistoricalReports && historicalOutput)) stale.push(path);
    }
    else { await mkdir(dirname(resolve(repositoryRoot, path)), { recursive: true }); await writeFile(resolve(repositoryRoot, path), content); }
  }
  if (stale.length) throw new Error(`Stale semantic artifacts: ${stale.join(", ")}`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await scanAndMaterialize(root, !process.argv.includes("--write"));
  process.stdout.write(`SEMANTIC_MATERIALIZER_PASS operations=${report.resolved.length} ${report.determinismHash}\n`);
}
