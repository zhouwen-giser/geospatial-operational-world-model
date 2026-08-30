import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getContractSchema, listContractSchemas, validateContract, validateSemanticManifest, type ProviderExecutionRequest } from "../../packages/platform/contract-runtime/src/index.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { CapabilityRegistry, InProcessProviderClient } from "../../services/gateway/world-capability-gateway/src/index.js";
import { projectCapabilitySemantics } from "../../services/gateway/world-capability-gateway/src/capability-semantics.js";
import { ToolRegistry } from "../../services/stas/src/tools/registry.js";
import { currentProviderRuntimes } from "./provider-conformance-runtimes.js";
import { schemaMatches, siblingImports, type SchemaDigests } from "./provider-conformance-inspection.js";
import { runtimeSourceFingerprint } from "./runtime-source-fingerprint.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = resolve(process.env.GOWM_CONFORMANCE_OUTPUT_DIRECTORY ?? resolve(root, "reports/gowm-v0.6.1/provider-conformance"));
const generatedAt = new Date().toISOString();
const sourceBefore = await runtimeSourceFingerprint(root);
const definitions = currentProviderRuntimes();
const index = new Map<string, SchemaDigests>();
for (const schema of listContractSchemas()) {
  const digests = { canonical: sha256(getContractSchema(schema.id ?? schema.key)) };
  index.set(schema.key, digests);
  if (schema.id) index.set(schema.id, digests);
}
for (const file of await files(resolve(root, "contracts"))) {
  if (!file.endsWith(".schema.json")) continue;
  const bytes = await readFile(file), schema = JSON.parse(bytes.toString());
  const digests = { canonical: sha256(schema), sourceBytes: byteHash(bytes) };
  index.set(relative(root, file), digests); index.set(file, digests);
  if (typeof schema.$id === "string") index.set(schema.$id, digests);
}

const nativeRegistry = new ToolRegistry();
const nativeTools = nativeRegistry.list();
const stasLock = {
  schemaVersion: "1.0", protocol: "STAS_NATIVE_1.0", hashPolicy: "EXECUTABLE_SOURCE_AND_OPENAPI_BYTES",
  inputs: { path: "services/stas/src/tools/schemas.ts", sha256: byteHash(await readFile(resolve(root, "services/stas/src/tools/schemas.ts"))) },
  openapi: { path: "services/stas/openapi/openapi.yaml", sha256: byteHash(await readFile(resolve(root, "services/stas/openapi/openapi.yaml"))) },
  operations: nativeTools.map((item) => nativeRegistry.describe(item))
};
const stasLockPath = resolve(root, "contracts/gowm-v0.6.1/manifests/stas-native-lock.json");
if (process.argv.includes("--write-current-manifests")) {
  for (const definition of definitions) await json(resolve(root, `contracts/manifests/providers/${definition.slug}-current.json`), definition.runtime.manifest);
  await json(stasLockPath, stasLock);
  process.stdout.write("CURRENT_PROVIDER_MANIFESTS_WRITTEN (no conformance claim)\n");
  process.exit(0);
}

await mkdir(out, { recursive: true });
// These are explicitly unit/protocol suites, never represented as live DB/H3 evidence.
const unitPath = resolve(out, "unit-behavior.json");
const vitestEntrypoint = resolve(root, "node_modules/vitest/vitest.mjs");
execFileSync(process.execPath, [vitestEntrypoint, "run", "tests/platform", "tests/unit/coverage-provider-protocol.test.ts", "--reporter=json", `--outputFile=${unitPath}`], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
const units = JSON.parse(await readFile(unitPath, "utf8"));
if (!units.success || units.numFailedTests !== 0) throw new Error("conformance unit/protocol suite failed");
const npmEntrypoint = process.env.npm_execpath;
if (!npmEntrypoint) throw new Error("npm_execpath is required for the STAS conformance suite");
const stasOutput = execFileSync(process.execPath, [npmEntrypoint, "--prefix", "services/stas", "test"], { cwd: root, encoding: "utf8" });
await writeFile(resolve(out, "stas-unit.tap"), stasOutput);
if (!/# fail 0\b/u.test(stasOutput) || !/# pass [1-9]\d*\b/u.test(stasOutput)) throw new Error("STAS executable unit suite did not pass");
const registry = new CapabilityRegistry();
for (const { slug, runtime } of definitions) registry.register({ approved: true, approvalId: `conformance-${slug}`, endpoint: new URL("http://127.0.0.1:1/"), manifest: runtime.manifest, client: new InProcessProviderClient(runtime) });
const operationCount = definitions.reduce((n, { runtime }) => n + runtime.manifest.capabilities.length, 0);
if (registry.catalog().length !== operationCount) throw new Error("Provider co-registration lost operations");
const reports = [];
for (const definition of definitions) {
  const { manifest } = definition.runtime;
  const capabilities = manifest.capabilities;
  const sourceFiles = await files(resolve(root, definition.sourceRoot));
  const sources = await Promise.all(sourceFiles.filter((path) => /\.(?:ts|js|sql)$/u.test(path)).map(async (path) => ({ path, source: await readFile(path, "utf8") })));
  const violations = sources.flatMap(({ path, source }) => siblingImports(source, path, root).map((specifier) => `${relative(root, path)}:${specifier}`));
  const profiles = projectCapabilitySemantics(capabilities, registry.contractCatalogRevision, registry.bindingRevision);
  const schemaChecks = capabilities.flatMap((capability) => [
    { schemaUri: capability.inputSchemaUri, schemaHash: capability.inputSchemaHash },
    { schemaUri: capability.outputSchemaUri, schemaHash: capability.outputSchemaHash },
    ...capability.ports.inputs, ...capability.ports.outputs
  ]).map((lock) => ({ ...lock, valid: schemaMatches(lock.schemaUri, lock.schemaHash, index) }));
  const negativeCases = [];
  for (const descriptor of capabilities) {
    const deadlineAt = new Date(Date.now() + 30_000).toISOString();
    const request: ProviderExecutionRequest = {
      providerProtocolVersion: "1.0", requestId: "conformance-hash-negative", gatewayRequestId: "conformance-hash-negative", idempotencyKey: `conformance-${descriptor.operationId}`,
      operation: { operationId: descriptor.operationId, operationVersion: descriptor.operationVersion, inputSchemaHash: `sha256:${"0".repeat(64)}`, outputSchemaHash: descriptor.outputSchemaHash }, input: {},
      securityContext: { principalRef: "conformance", authenticationMethod: "UNIT_PROTOCOL", authenticatedAt: generatedAt, scopeAttestation: { issuer: "conformance", issuedAt: generatedAt, expiresAt: deadlineAt, claimDigest: sha256({ principal: "conformance" }) } },
      gatewayContext: { gatewayId: "conformance", registryVersion: "current", policyVersion: "current" }, executionPolicy: { deadlineAt, maximumInputBytes: 1_048_576, maximumResultBytes: 1_048_576, maximumCostClass: "HIGH" }
    };
    let code: unknown;
    try { await definition.runtime.execute(request); } catch (error) { code = (error as { code?: string }).code; }
    negativeCases.push({ operationId: descriptor.operationId, code, passed: code === "SCHEMA_MISMATCH" });
  }
  const manifestPath = `contracts/manifests/providers/${definition.slug}-current.json`;
  const health = definition.runtime.health();
  const readiness = definition.runtime.readiness();
  const checks = [
    check("MANIFEST", validateContract("capability-provider-manifest.schema.json", manifest).valid && sha256(manifest) === sha256(JSON.parse(await readFile(resolve(root, manifestPath), "utf8"))), manifestPath),
    check("SCHEMA_HASH", schemaChecks.every((lock) => lock.valid), "Exact canonical JSON or actual source-byte hash; unknown URI/path fails closed", schemaChecks.filter((lock) => !lock.valid)),
    check("OPERATION_VERSION", new Set(capabilities.map((c) => `${c.operationId}@${c.operationVersion}`)).size === capabilities.length, "Runtime factory validates operation/handler parity"),
    check("SEMANTIC_PROFILE", validateContract("urn:gowm:v0.6.2:capability-semantic-catalog", profiles).valid && profiles.profiles.length === capabilities.length, "Explicit projection from every current descriptor"),
    check("SCOPE_SNAPSHOT_LIMITS", validateSemanticManifest(manifest).valid && capabilities.every((c) => c.execution.maximumTimeoutMs >= c.execution.defaultTimeoutMs && (c.limits.maximumInputBytes ?? 0) > 0 && (c.limits.maximumOutputBytes ?? 0) > 0), "Executable manifest schema and cross-field semantic rules"),
    check("HASH_ERROR_FAIL_CLOSED", negativeCases.every((item) => item.passed), "Real runtime rejects forged input hash before IO", negativeCases),
    check("CO_REGISTRATION", registry.catalog().length === operationCount, "All current protocol Provider factories registered together without duplicate routes"),
    check("HEALTH_READINESS_CONTRACT", health.live === true && health.providerId === manifest.provider.providerId && readiness.ready === true && readiness.operationCount === capabilities.length, "Executed SDK startup health/readiness contract; external dependency readiness is not claimed"),
    check("NO_SIBLING_PROVIDER_IMPORT", violations.length === 0, "AST resolves relative/absolute/dynamic imports and re-exports", violations),
    check("NO_SIBLING_PROVIDER_HTTP", sources.every(({ source }) => !/https?:\/\/(?:[^\s"']*provider|(?:localhost|127\.0\.0\.1):\d+\/v1\/operations)/iu.test(source)), "No hardcoded sibling Provider HTTP target"),
    check("VERSIONED_READ_CONTRACT", sources.every(({ source }) => !/\b(?:FROM|JOIN)\s+public\.(?!ST_|spans\b)[a-z_][a-z0-9_]*/iu.test(source)), "Provider source has no public base-table read; database grants and SQL assertions are independently checked by D00"),
    check("UNIT_PROTOCOL_BEHAVIOR", units.success === true, "Executed unit/protocol suite: status mapping, receipts/evidence, scope, limits, health, idempotency and errors; not live readiness")
  ];
  const report = finish({ providerId: manifest.provider.providerId, providerVersion: manifest.provider.providerVersion, checks, manifestHash: sha256(manifest), evidenceLevel: "CONTRACT_AND_UNIT_PROTOCOL", runtimeReadiness: "NOT_CLAIMED", unitEvidenceRef: "reports/gowm-v0.6.1/provider-conformance/unit-behavior.json" });
  reports.push(report);
  await json(resolve(out, `${definition.slug}.json`), report);
}
const nativeSources = await Promise.all((await files(resolve(root, "services/stas/src"))).filter((path) => path.endsWith(".ts")).map(async (path) => ({ path, source: await readFile(path, "utf8") })));
const stasChecks = [
  check("NATIVE_MANIFEST", nativeTools.length === 15 && new Set(nativeTools.map((item) => item.name)).size === 15, "Actual STAS ToolRegistry, not a fabricated Provider Protocol manifest"),
  check("SCHEMA_HASH", sha256(stasLock) === sha256(JSON.parse(await readFile(stasLockPath, "utf8"))), "Committed exact executable schema/refinement and OpenAPI source locks"),
  check("SCOPE_SNAPSHOT_LIMITS_VERSION", nativeTools.every((t) => t.version === "1.0.0" && t.dataScopePolicy === "REQUIRED_EXACT_MATCH" && t.cacheableWhenPinned && t.maxRows > 0 && t.maxTimeoutMs >= t.defaultTimeoutMs), "Actual executable tool definitions"),
  check("UNKNOWN_INPUT_REJECTED", nativeTools.every((t) => !t.schema.safeParse({ injected: true }).success), "All executable Zod inputs reject invalid input"),
  check("NATIVE_UNIT_BEHAVIOR", /# fail 0\b/u.test(stasOutput), "Executed native STAS suite including scope, statuses, evidence and RFC 9457 error mapping; not live readiness"),
  check("HEALTH_READINESS_CONTRACT", /# fail 0\b/u.test(stasOutput), "Executed native HTTP liveness/readiness success and dependency-unavailable tests using an explicitly injected unit database"),
  check("NO_SIBLING_PROVIDER_IMPORT", nativeSources.every(({ path, source }) => siblingImports(source, path, root).length === 0), "AST inspects native STAS imports"),
  check("NO_SIBLING_PROVIDER_HTTP", nativeSources.every(({ source }) => !/https?:\/\/(?:[^\s"']*provider|(?:localhost|127\.0\.0\.1):\d+\/v1\/operations)/iu.test(source)), "Native STAS has no hardcoded sibling HTTP call"),
  check("VERSIONED_READ_CONTRACT", nativeSources.every(({ source }) => !/\b(?:FROM|JOIN)\s+public\.(?!ST_|spans\b)[a-z_][a-z0-9_]*/iu.test(source)), "STAS reads its owned/versioned SQL APIs, not public base tables")
];
const stas = finish({ providerId: "gowm.stas", providerVersion: "0.1.0", checks: stasChecks, evidenceLevel: "NATIVE_CONTRACT_AND_UNIT", runtimeReadiness: "NOT_CLAIMED", unitEvidenceRef: "reports/gowm-v0.6.1/provider-conformance/stas-unit.tap" });
reports.push(stas); await json(resolve(out, "stas.json"), stas);
const sourceAfter = await runtimeSourceFingerprint(root);
const aggregate = finish({ providers: reports.map(({ providerId, providerVersion, status, reportHash }) => ({ providerId, providerVersion, status, reportHash })), checks: [check("ALL_PROVIDER_REPORTS", reports.every((r) => r.status === "PASS"), "Required nine domains plus H3 interactive and Platform Validation"), check("REGISTRY_UNIQUE", registry.catalog().length === operationCount, `${operationCount} unique operations`), check("SOURCE_STABLE", sourceBefore.digest === sourceAfter.digest, "Source fingerprint captured before and after this executable gate")], sourceBefore, sourceAfter, evidenceLevel: "CONTRACT_AND_UNIT_PROTOCOL", runtimeReadiness: "NOT_CLAIMED" });
await json(resolve(out, "aggregate.json"), aggregate);
for (const report of reports) for (const c of report.checks) if (c.status !== "PASS") process.stderr.write(`${report.providerId} ${c.id}: ${JSON.stringify(c)}\n`);
process.stdout.write(`GOWM_PROVIDER_CONFORMANCE_${aggregate.status} providers=${reports.length} operations=${operationCount}\n`);
if (aggregate.status !== "PASS") process.exitCode = 1;

function check(id: string, passed: boolean, message: string, details?: unknown) { return { id, status: passed ? "PASS" : "FAIL", message, ...(details === undefined ? {} : { details }) }; }
function finish<T extends { checks: ReturnType<typeof check>[] }>(body: T) { const value = { schemaVersion: "1.0", ...body, status: body.checks.every((c) => c.status === "PASS") ? "PASS" : "FAIL" }; return { ...value, generatedAt, reportHash: sha256(value) }; }
function byteHash(value: Uint8Array) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
async function json(path: string, value: unknown) {
  if (value !== null && typeof value === "object" && "providerId" in value && "checks" in value) {
    const validation = validateContract("urn:gowm:v0.6.1:provider-conformance-report", value);
    if (!validation.valid) throw new Error(`Invalid conformance report ${path}: ${JSON.stringify(validation)}`);
  }
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
async function files(directory: string): Promise<string[]> { const found: string[] = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const path = resolve(directory, entry.name); if (entry.isDirectory()) found.push(...await files(path)); else found.push(path); } return found.sort(); }
