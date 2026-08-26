import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { parse } from "pgsql-parser";
import {
  canonicalSha256, validateContract, validateCapabilityDescriptorSemantics,
  type CapabilityDescriptor, type CapabilitySemanticProfileV1
} from "../../contract-runtime/src/index.js";

export type SemanticProfile = CapabilitySemanticProfileV1;
export interface SemanticIssue { rule: string; operation: string; message: string }
export interface ImplementationEvidence {
  referenceInput: boolean;
  referenceOutput: boolean;
  outputFeatures: string[];
  domainStatuses: string[];
  exactSpatial: boolean;
  candidateOnly: boolean;
  distanceUnit: boolean;
  distanceModel: boolean;
  implementation: boolean;
  blackBox: boolean;
  verificationPorts: boolean;
}
export const EMPTY_EVIDENCE: ImplementationEvidence = {
  referenceInput: false, referenceOutput: false, outputFeatures: [], domainStatuses: [],
  exactSpatial: false, candidateOnly: false, distanceUnit: false, distanceModel: false,
  implementation: false, blackBox: false, verificationPorts: false
};
export const operationKey = (c: Pick<CapabilityDescriptor, "operationId" | "operationVersion">): string => `${c.operationId}@${c.operationVersion}`;
const key = operationKey;
const executable = new Set(["STABLE", "PREVIEW", "EXPERIMENTAL", "DEPRECATED"]);

/** Offline only: the Gateway never imports implementation scanners or materialization rules. */
export function checkSemanticRules(
  descriptor: CapabilityDescriptor,
  evidence: ImplementationEvidence,
  catalog: readonly CapabilityDescriptor[] = [descriptor],
  requireBlackBox = true
): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const fail = (rule: string, message: string) => issues.push({ rule, operation: key(descriptor), message });
  const p = descriptor.semanticProfile;
  if (!p) { fail("S014", "Explicit semanticProfile is missing"); return issues; }
  const validation = validateContract("urn:gowm:v0.6.2:capability-semantic-profile", p);
  for (const issue of validation.issues) fail("VOCABULARY", `${issue.path}: ${issue.message}`);
  if (evidence.referenceInput && p.acceptedReferenceKinds.length === 0) fail("S001", "Reference input lacks accepted kinds");
  if (evidence.referenceOutput && p.producedReferenceKinds.length === 0) fail("S002", "Reference output lacks produced kinds");
  const bound = ["WORLD_SNAPSHOT_BOUND", "DATASET_VERSION_BOUND"].includes(descriptor.dataBinding);
  if (bound && (p.timeSemantics === "NONE" || p.freshnessSemantics === "NONE" || descriptor.snapshotPolicy.dataSnapshot !== "REQUIRED")) fail("S003", "Data-bound operation requires time, freshness and data snapshot");
  if (descriptor.dataBinding === "WORLD_INDEPENDENT" && descriptor.resultSemantics === "TRANSFORMATION" &&
      (p.timeSemantics !== "NONE" || p.freshnessSemantics !== "NONE" || p.negativeEvidencePolicy !== "NOT_APPLICABLE" || p.relationSemantics.length > 0)) fail("S004", "Stateless transformation cannot assert world evidence");
  if (evidence.candidateOnly && p.spatialSemantics !== "CANDIDATE") fail("S005", "Coarse index or cover cannot be exact");
  if (p.exactVerification) {
    const target = catalog.find((c) => key(c) === key(p.exactVerification!));
    if (!target || target.semanticProfile?.spatialSemantics !== "EXACT" || !executable.has(target.maturity) || !evidence.verificationPorts) fail("S006", "Exact verifier must exist, be exact/executable, and have a checked input mapping");
    const seen = new Set<string>([key(descriptor)]);
    let next: CapabilityDescriptor | undefined = target;
    while (next) {
      if (seen.has(key(next))) { fail("S006", "Verification graph contains a cycle"); break; }
      seen.add(key(next));
      const ref: SemanticProfile["exactVerification"] = next.semanticProfile?.exactVerification;
      next = ref ? catalog.find((c) => key(c) === key(ref)) : undefined;
    }
  }
  if (p.spatialSemantics === "CANDIDATE" && p.resultNature === "FACT") fail("S006", "Candidate output cannot be an exact world fact");
  if (["WORLD_STATE", "SPATIAL", "TEMPORAL", "ANALYSIS"].includes(p.domain) && !p.negativeEvidencePolicy) fail("S007", "Negative evidence policy is required");
  if (evidence.domainStatuses.length) {
    const mapping = p.domainStatus?.mapping;
    if (!mapping || evidence.domainStatuses.some((s) => !Object.hasOwn(mapping, s))) fail("S008", "Domain statuses must be completely mapped");
    for (const status of ["NO_DATA", "UNKNOWN", "OBSERVATION_GAP", "INDETERMINATE", "STALE"]) {
      if (mapping?.[status] && !["NO_DATA", "INDETERMINATE", "STALE"].includes(mapping[status]!)) fail("S008", `${status} cannot imply completed/negative evidence`);
    }
  }
  if (p.spatialSemantics === "EXACT" && !evidence.exactSpatial) fail("S009", "Exact spatial semantics lack implementation evidence");
  if (p.relationSemantics.includes("NEAR") && (!evidence.distanceUnit || !evidence.distanceModel)) fail("S010", "NEAR requires a declared unit and implementation distance model");
  const allowed: Record<string, string[]> = {
    TRANSFORMATION: ["DERIVED"], DERIVED_INDEX: ["DERIVED"], DERIVED_ANALYSIS: ["DERIVED", "PLAN"],
    WORLD_PROJECTION: ["PROJECTION"], DATA_QUERY: ["FACT", "CATALOG"], VALIDATION: ["VALIDATION"]
  };
  if (!allowed[descriptor.resultSemantics]?.includes(p.resultNature)) fail("S011", "Result nature conflicts with descriptor result semantics");
  if (["DERIVED", "PLAN"].includes(p.resultNature) && evidence.outputFeatures.some((f) => ["validUntil", "dataSnapshot", "worldVersion", "routingSnapshot"].includes(f)) && p.freshnessSemantics === "NONE") fail("S012", "Persisted derived result requires freshness");
  for (const issue of validateCapabilityDescriptorSemantics(descriptor).issues) fail("S013", issue.message);
  if (!bound && (p.timeSemantics !== "NONE" || p.freshnessSemantics !== "NONE")) fail("S013", "Caller-only operation cannot invent a world snapshot/time authority");
  if (descriptor.maturity === "STABLE" && (!evidence.implementation || (requireBlackBox && !evidence.blackBox))) fail("S014", "Stable requires implementation and current black-box evidence");
  return issues.sort((a, b) => `${a.rule}:${a.message}`.localeCompare(`${b.rule}:${b.message}`));
}

export interface TypeScriptInspection {
  symbols: string[]; calls: string[]; imports: string[]; strings: string[]; properties: string[];
  siblingImports: string[]; diagnostics: number;
}

/** Compiler API, including dynamic imports, handler methods and literal schema/status construction. */
export function inspectTypeScript(source: string, filename: string, repositoryRoot: string): TypeScriptInspection {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const symbols = new Set<string>(), calls = new Set<string>(), imports = new Set<string>();
  const strings = new Set<string>(), properties = new Set<string>(), siblings = new Set<string>();
  const providerRoot = resolve(repositoryRoot, "services/providers");
  const own = filename.startsWith(`${providerRoot}/`) ? filename.slice(providerRoot.length + 1).split("/")[0] : undefined;
  const collectImport = (node: ts.Node | undefined) => {
    if (!node || !ts.isStringLiteralLike(node)) return;
    imports.add(node.text);
    const absolute = node.text.startsWith(".") ? resolve(dirname(filename), node.text) : node.text;
    const parts = absolute.split("/");
    const at = parts.findIndex((part, i) => part === "services" && parts[i + 1] === "providers");
    if (at >= 0 && parts[at + 2] !== own) siblings.add(node.text);
  };
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) && node.name) symbols.add(node.name.getText(tree));
    if (ts.isStringLiteralLike(node)) strings.add(node.text);
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) properties.add(node.name.getText(tree).replaceAll('"', "").replaceAll("'", ""));
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) collectImport(node.moduleSpecifier);
    if (ts.isCallExpression(node)) {
      calls.add(node.expression.getText(tree));
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require") collectImport(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length ?? 0;
  return { symbols: [...symbols].sort(), calls: [...calls].sort(), imports: [...imports].sort(), strings: [...strings].sort(), properties: [...properties].sort(), siblingImports: [...siblings].sort(), diagnostics };
}

export interface SqlInspection { hash: string; functions: string[]; operators: string[]; relations: string[]; exact: boolean; bboxOnly: boolean; geographyDistance: boolean }
/** Inspects parsed SQL nodes, never regex-matches SQL for proof. Invalid SQL throws. */
export async function inspectSql(sql: string): Promise<SqlInspection> {
  const tree: unknown = await parse(sql);
  const functions = new Set<string>(), operators = new Set<string>(), relations = new Set<string>();
  let geography = false;
  const names = (parts: unknown): string[] => Array.isArray(parts) ? parts.flatMap((p) => {
    const s = (p as { String?: { sval?: string } }).String?.sval;
    return typeof s === "string" ? [s.toLowerCase()] : [];
  }) : [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Record<string, any>;
    if (node.FuncCall) functions.add(names(node.FuncCall.funcname).join("."));
    if (node.A_Expr) for (const name of names(node.A_Expr.name)) operators.add(name);
    if (node.RangeVar) relations.add([node.RangeVar.schemaname, node.RangeVar.relname].filter(Boolean).join("."));
    if (node.typeName && names(node.typeName.names).includes("geography")) geography = true;
    Object.values(node).forEach(visit);
  };
  visit(tree);
  const exact = [...functions].some((f) => ["st_within", "st_covers", "st_coveredby", "st_contains", "st_intersects", "st_dwithin", "st_distance"].includes(f.split(".").at(-1)!));
  return { hash: canonicalSha256(tree), functions: [...functions].sort(), operators: [...operators].sort(), relations: [...relations].sort(), exact, bboxOnly: operators.has("&&") && !exact, geographyDistance: geography && [...functions].some((f) => ["st_dwithin", "st_distance"].includes(f)) };
}

export interface SchemaInspection { paths: string[]; referenceKinds: string[]; statusPaths: Record<string, string[]>; sourceUris: string[] }
/** Follows local/URN schema references with a cycle guard and records exact status paths. */
export function inspectSchema(schema: unknown, resolveReference: (ref: string, parent: unknown) => unknown): SchemaInspection {
  const paths = new Set<string>(), kinds = new Set<string>(), uris = new Set<string>();
  const statusPaths: Record<string, string[]> = {};
  const visit = (value: unknown, path: string, stack: Set<unknown>, property?: string) => {
    if (!value || typeof value !== "object" || stack.has(value)) return;
    const next = new Set(stack).add(value), node = value as Record<string, any>;
    if (typeof node.$id === "string") uris.add(node.$id);
    if (node.$ref) visit(resolveReference(node.$ref, value), path, next, property);
    if (property === "kind") {
      for (const k of node.enum ?? (node.const ? [node.const] : [])) if (["WORLD_OBJECT", "SPATIAL_OBJECT", "DATASET", "LAYER", "LAYER_FEATURE", "OPERATIONAL_TASK", "DERIVED_REFERENCE", "REFERENCE_SET", "QUERY_RESULT"].includes(k)) kinds.add(k);
    }
    if (property === "status" || property === "currentness" || property === "resolutionStatus") {
      const terms = node.enum ?? (node.const ? [node.const] : []);
      if (terms.length) statusPaths[path] = [...new Set([...(statusPaths[path] ?? []), ...terms as string[]])].sort();
    }
    for (const [name, child] of Object.entries(node.properties ?? {})) { paths.add(`${path}/${name}`); visit(child, `${path}/${name}`, next, name); }
    if (node.items) visit(node.items, `${path}/*`, next);
    for (const branch of [...(node.oneOf ?? []), ...(node.anyOf ?? []), ...(node.allOf ?? [])]) visit(branch, path, next, property);
  };
  visit(schema, "", new Set());
  return { paths: [...paths].sort(), referenceKinds: [...kinds].sort(), statusPaths, sourceUris: [...uris].sort() };
}

export function byteHash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

export interface MaterializationInput {
  descriptor: CapabilityDescriptor;
  declaration?: SemanticProfile;
  evidence: ImplementationEvidence;
  catalog: readonly CapabilityDescriptor[];
}
export function materializeProfile(input: MaterializationInput): {
  status: "RESOLVED" | "CONFLICT" | "INSUFFICIENT_CONTRACT";
  profile?: SemanticProfile; issues: SemanticIssue[]; profileHash?: string;
} {
  if (!input.declaration || !input.evidence.implementation) return {
    status: "INSUFFICIENT_CONTRACT", issues: [{ rule: "S014", operation: key(input.descriptor), message: "Exhaust contract/schema/ports/implementation/SQL/tests/ADR/callers; no fallback semantics are permitted" }]
  };
  const descriptor = { ...input.descriptor, semanticProfile: structuredClone(input.declaration) };
  const catalog = input.catalog.map((c) => key(c) === key(descriptor) ? descriptor : c);
  const issues = checkSemanticRules(descriptor, input.evidence, catalog, false);
  if (issues.length) return { status: "CONFLICT", issues };
  return { status: "RESOLVED", profile: descriptor.semanticProfile, profileHash: canonicalSha256(descriptor.semanticProfile), issues: [] };
}
