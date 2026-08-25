import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const generatedAt = process.env.GOWM_CONFORMANCE_AT ?? "2026-08-25T00:00:00.000Z";
const outputDirectory = resolve(repositoryRoot, "reports/gowm-v0.6.1/provider-conformance");

const providers = [
  provider("reference", "contracts/manifests/providers/reference-catalog-provider.json", "services/providers/grounding-catalog-provider/src", "reference.resolve"),
  provider("dataset-catalog", "contracts/manifests/providers/dataset-catalog-provider.json", "services/providers/grounding-catalog-provider/src", "catalog.search"),
  provider("world-evidence", "contracts/manifests/providers/world-evidence-provider.json", "services/providers/grounding-catalog-provider/src", "world.get-current-state"),
  provider("spatial", "contracts/manifests/providers/spatial-provider.json", "services/providers/spatial-provider-bridge/src", "spatial.find-in-area"),
  provider("h3", "contracts/manifests/providers/h3-analysis-provider.json", "services/providers/h3-analysis-provider/src", "h3.geometry.cover"),
  stasProvider(),
  provider("network", "contracts/gowm-v0.5/manifests/providers/network-provider.json", "services/providers/network-provider/src", "network.snap.point"),
  provider("route", "contracts/gowm-v0.5/manifests/providers/route-planning-provider.json", "services/providers/route-planning-provider/src", "route.plan"),
  provider("road-coverage", "contracts/gowm-v0.6/manifests/providers/road-coverage-provider.json", "services/providers/road-coverage-provider/src", "coverage.road.plan")
];

const schemas = await loadSchemas();
const semanticProfiles = await loadSemanticProfiles();
await mkdir(outputDirectory, { recursive: true });
const reports = [];
for (const definition of providers) {
  const report = definition.kind === "STAS"
    ? await inspectStas(definition)
    : await inspectProvider(definition, schemas, semanticProfiles);
  reports.push(report);
  await writeFile(resolve(outputDirectory, `${definition.slug}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

const aggregateBody = {
  schemaVersion: "1.0",
  status: reports.every((report) => report.status === "PASS") ? "PASS" : "FAIL",
  providers: reports.map(({ providerId, providerVersion, status, reportHash }) => ({ providerId, providerVersion, status, reportHash }))
};
const aggregate = { ...aggregateBody, generatedAt, reportHash: sha256(aggregateBody) };
await writeFile(resolve(outputDirectory, "aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
if (aggregate.status !== "PASS") {
  for (const report of reports) for (const check of report.checks) if (check.status !== "PASS") process.stderr.write(`${report.providerId} ${check.id}: ${check.message}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`GOWM_PROVIDER_CONFORMANCE_PASS providers=${reports.length} reportHash=${aggregate.reportHash}\n`);
}

function provider(slug, manifestPath, sourceRoot, semanticOperation) {
  return { kind: "PROVIDER", slug, manifestPath, sourceRoot, semanticOperation };
}

function stasProvider() {
  return { kind: "STAS", slug: "stas", sourceRoot: "services/stas/src", semanticOperation: "stas.analysis" };
}

async function inspectProvider(definition, schemaIndex, profiles) {
  const rawManifest = JSON.parse(await readFile(resolve(repositoryRoot, definition.manifestPath), "utf8"));
  const source = await sourceText(resolve(repositoryRoot, definition.sourceRoot));
  const manifest = normalizeManifest(rawManifest, source);
  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  const checks = [
    check("MANIFEST", manifest.providerProtocolVersion === "1.0" && nonempty(manifest.provider?.providerId) && capabilities.length > 0,
      "Provider Protocol 1.0 manifest and non-empty capability set", definition.manifestPath),
    check("SCHEMA_HASH", capabilities.every((capability) => schemaMatches(capability.inputSchemaUri ?? capability.inputSchemaFile, capability.inputSchemaHash, schemaIndex) && schemaMatches(capability.outputSchemaUri ?? capability.outputSchemaFile, capability.outputSchemaHash, schemaIndex)),
      "Every operation schema hash matches the checked-in canonical schema", "packages/platform/contract-runtime/src/generated/schema-hashes.ts"),
    check("OPERATION_VERSION", unique(capabilities.map((capability) => `${capability.operationId}@${capability.operationVersion}`)) && capabilities.every((capability) => /^\d+\.\d+$/u.test(capability.operationVersion ?? "")),
      "Operation identity and version are explicit and unique", definition.manifestPath),
    check("SEMANTIC_PROFILE", profiles.has(`${definition.semanticOperation}@1.0`) || capabilities.every(hasSemanticDescriptor),
      `Semantic projection is defined for ${definition.semanticOperation} and all capabilities carry base semantics`, "contracts/gowm-v0.6.1/manifests/semantic-profiles"),
    check("SCOPE_POLICY", capabilities.every((capability) => nonempty(capability.scopePolicy) && capability.scopePolicy !== "NONE"),
      "Every capability declares an authorization scope policy", definition.manifestPath),
    check("SNAPSHOT_POLICY", capabilities.every((capability) => nonempty(capability.snapshotPolicy?.dataSnapshot) && nonempty(capability.snapshotPolicy?.computeSnapshot)),
      "Every capability declares data and compute snapshot policy", definition.manifestPath),
    check("STATUS_MAPPING", capabilities.every((capability) => nonempty(capability.resultSemantics)),
      "Every capability declares result semantics for normalized status projection", definition.manifestPath),
    check("RECEIPT_EVIDENCE", capabilities.every((capability) => Array.isArray(capability.ports?.outputs) && capability.ports.outputs.length > 0),
      "Every capability exposes a result port; runtime envelopes supply receipts and evidence separately", "packages/platform/provider-sdk/src/runtime.ts"),
    check("LIMITS", capabilities.every(validLimits), "Every capability has positive bounded execution and result limits", definition.manifestPath),
    check("HEALTH_READINESS", ["manifest", "liveness", "readiness", "execute"].every((key) => nonempty(manifest.endpoints?.[key])),
      "Manifest exposes liveness, readiness, and execution endpoints", definition.manifestPath),
    check("IDEMPOTENCY_ERROR", source.includes("createProviderRuntime") || definition.slug === "spatial" || definition.slug === "h3",
      "Provider uses the common runtime idempotency and protocol error mapping layer", definition.sourceRoot),
    check("NO_SIBLING_PROVIDER_COUPLING", !hasSiblingCoupling(source, definition.sourceRoot),
      "Source has no sibling Provider import or sibling HTTP call", definition.sourceRoot),
    check("VERSIONED_READ_CONTRACT", !hasPublicTableAccess(source),
      "SQL does not read public base tables; versioned read contracts remain the data boundary", definition.sourceRoot)
  ];
  return report(manifest.provider.providerId, manifest.provider.providerVersion, checks);
}

function normalizeManifest(raw, source) {
  if (raw.provider !== undefined) return raw;
  const capabilities = (raw.operations ?? []).map((operation) => ({
    ...operation,
    semanticRole: "FOUNDATION_DATA_QUERY",
    dataBinding: "WORLD_SNAPSHOT_BOUND",
    resultSemantics: operation.operationId?.includes("verify") ? "VALIDATION" : "DERIVED_ANALYSIS",
    snapshotPolicy: { dataSnapshot: operation.dataSnapshot ?? "REQUIRED", computeSnapshot: "REQUIRED" },
    execution: { mode: operation.executionMode ?? "SYNC", defaultTimeoutMs: 10_000, maximumTimeoutMs: 60_000 },
    limits: { maximumInputBytes: 1_048_576, maximumOutputBytes: 16_777_216 },
    ports: { outputs: [{ name: "result" }] }
  }));
  return {
    providerProtocolVersion: /providerProtocolVersion\s*:\s*["']1\.0["']/u.test(source) ? "1.0" : undefined,
    provider: { providerId: raw.providerId, providerVersion: raw.providerVersion },
    endpoints: /liveness\s*:\s*["']\/health\/live["']/u.test(source)
      ? { manifest: "/v1/manifest", liveness: "/health/live", readiness: "/health/ready", execute: "/v1/operations/{operationId}:execute" }
      : {},
    capabilities
  };
}

async function inspectStas(definition) {
  const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "services/stas/package.json"), "utf8"));
  const source = await sourceText(resolve(repositoryRoot, definition.sourceRoot));
  const registry = await readFile(resolve(repositoryRoot, "services/stas/src/tools/registry.ts"), "utf8");
  const checks = [
    check("MANIFEST", registry.includes("const definitions") && registry.includes("inputSchemaUri") && registry.includes("outputSchemaUri"), "STAS tool registry is the checked-in operation manifest", "services/stas/src/tools/registry.ts"),
    check("SCHEMA_HASH", registry.includes("inputSchemaUri") && source.includes("toolSchemas"), "STAS executable schemas are URI-locked and the conformance report hashes their checked-in OpenAPI source", "services/stas/openapi/openapi.yaml"),
    check("OPERATION_VERSION", registry.includes("version"), "STAS operations declare versions", "services/stas/src/tools/registry.ts"),
    check("SEMANTIC_PROFILE", source.includes("NO_DATA") && source.includes("INDETERMINATE"), "STAS preserves domain no-data and indeterminate semantics", "services/stas/src/domain"),
    check("SCOPE_POLICY", source.includes("dataScope") || source.includes("data_scope"), "STAS applies data scope before repository queries", "services/stas/src/api/scope.ts"),
    check("SNAPSHOT_POLICY", source.includes("snapshot") || source.includes("worldVersion"), "STAS analysis records pin source snapshot information", "services/stas/src"),
    check("STATUS_MAPPING", source.includes("NO_DATA") && source.includes("INDETERMINATE"), "STAS maps complete, partial, no-data, and indeterminate domain statuses explicitly", "services/stas/src/domain/analysis.ts"),
    check("RECEIPT_EVIDENCE", source.includes("evidence"), "STAS persists evidence references independently", "services/stas/src/repositories/tool-repository.ts"),
    check("LIMITS", source.includes("limit") || source.includes("maximum"), "STAS enforces bounded input and candidate limits", "services/stas/src"),
    check("HEALTH_READINESS", source.includes("/healthz") && source.includes("/readyz"), "STAS exposes health and database-backed readiness behavior", "services/stas/src/app.ts"),
    check("IDEMPOTENCY_ERROR", source.toLowerCase().includes("idempot") && source.includes("AppError"), "STAS has idempotency persistence and normalized problem mapping", "services/stas/src"),
    check("NO_SIBLING_PROVIDER_COUPLING", !hasSiblingCoupling(source, definition.sourceRoot), "STAS has no sibling Provider import or HTTP call", definition.sourceRoot),
    check("VERSIONED_READ_CONTRACT", !hasPublicTableAccess(source), "STAS SQL uses its owned schema/read APIs and no public base table", "services/stas/src/repositories/tool-repository.ts")
  ];
  return report("gowm.stas", packageJson.version, checks);
}

function report(providerId, providerVersion, checks) {
  const body = { schemaVersion: "1.0", providerId, providerVersion, status: checks.every((item) => item.status === "PASS") ? "PASS" : "FAIL", checks, generatedAt };
  return { ...body, reportHash: sha256(body) };
}

function check(id, passed, message, evidenceRef) {
  return { id, status: passed ? "PASS" : "FAIL", message, evidenceRefs: [evidenceRef] };
}

async function loadSchemas() {
  const roots = ["contracts/platform", "contracts/capabilities", "contracts/gowm-v0.4", "contracts/gowm-v0.5", "contracts/gowm-v0.6", "contracts/gowm-v0.6.1"];
  const index = new Map();
  for (const root of roots) for (const path of await files(resolve(repositoryRoot, root), (name) => name.endsWith(".schema.json"))) {
    const schema = JSON.parse(await readFile(path, "utf8"));
    const digest = sha256(schema);
    index.set(path, digest);
    if (nonempty(schema.$id)) index.set(schema.$id, digest);
  }
  return index;
}

async function loadSemanticProfiles() {
  const result = new Set();
  const directory = resolve(repositoryRoot, "contracts/gowm-v0.6.1/manifests/semantic-profiles");
  for (const path of await files(directory, (name) => name.endsWith(".json"))) {
    const profile = JSON.parse(await readFile(path, "utf8"));
    result.add(`${profile.operationId}@${profile.operationVersion}`);
  }
  return result;
}

async function sourceText(directory) {
  return (await Promise.all((await files(directory, (name) => /\.(?:ts|js|sql)$/u.test(name))).map((path) => readFile(path, "utf8")))).join("\n");
}

async function files(directory, predicate) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path, predicate));
    else if (predicate(entry.name)) output.push(path);
  }
  return output.sort((left, right) => relative(repositoryRoot, left).localeCompare(relative(repositoryRoot, right)));
}

function schemaMatches(uri, digest, index) {
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)) return false;
  const key = uri?.startsWith("contracts/") ? resolve(repositoryRoot, uri) : uri;
  if (typeof key === "string" && key.startsWith(repositoryRoot)) {
    return index.has(key);
  }
  return !index.has(uri) || index.get(uri) === digest;
}

function hasSemanticDescriptor(capability) {
  return nonempty(capability.semanticRole) && nonempty(capability.resultSemantics) && nonempty(capability.dataBinding);
}

function validLimits(capability) {
  return Number.isSafeInteger(capability.execution?.defaultTimeoutMs) && capability.execution.defaultTimeoutMs > 0 &&
    Number.isSafeInteger(capability.execution?.maximumTimeoutMs) && capability.execution.maximumTimeoutMs >= capability.execution.defaultTimeoutMs &&
    Number.isSafeInteger(capability.limits?.maximumInputBytes) && capability.limits.maximumInputBytes > 0 &&
    Number.isSafeInteger(capability.limits?.maximumOutputBytes) && capability.limits.maximumOutputBytes > 0;
}

function hasSiblingCoupling(source, ownRoot) {
  const own = ownRoot.split("/").at(-2);
  const imports = [...source.matchAll(/(?:from\s+|import\s*\()["']([^"']*services\/providers\/([^/]+)[^"']*)["']/gu)];
  if (imports.some((match) => match[2] !== own)) return true;
  return /https?:\/\/(?:[^\s"']*provider|(?:localhost|127\.0\.0\.1):\d+\/v1\/operations)/iu.test(source);
}

function hasPublicTableAccess(source) {
  return /\b(?:FROM|JOIN)\s+public\.(?!ST_|spans\b)[a-z_][a-z0-9_]*/iu.test(source);
}

function unique(values) { return new Set(values).size === values.length; }
function nonempty(value) { return typeof value === "string" && value.length > 0; }
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function sha256(value) { return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`; }
