import { canonicalSha256 } from "./canonical-json.js";
import type {
  CapabilityCatalog,
  CapabilityDescriptor,
  CapabilityProviderManifest,
  CapabilityResultEnvelope,
  GowmV071QuerySnapshotManifest,
  H3CellSetEnvelope,
  PlatformCommonDefinitionsOperationRef,
  ProviderExecutionRequest,
  ProviderLock,
  WorldQueryResult,
  WorldQueryPlanV2,
  WorldQueryPlanV2InputBinding
} from "./generated/contracts.js";
import type { ValidationIssue, ValidationResult } from "./schema-validator.js";

const issue = (path: string, keyword: string, message: string): ValidationIssue => ({
  path,
  schemaPath: "semantic",
  keyword,
  message
});

const result = (issues: ValidationIssue[]): ValidationResult => ({
  valid: issues.length === 0,
  issues
});

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

export function validateCapabilityDescriptorSemantics(
  descriptor: CapabilityDescriptor,
  path = ""
): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (descriptor.execution.defaultTimeoutMs > descriptor.execution.maximumTimeoutMs) {
    issues.push(issue(`${path}/execution/defaultTimeoutMs`, "timeoutOrder", "must not exceed maximumTimeoutMs"));
  }
  const resourceResolution = descriptor.snapshotPolicy.resourceResolution;
  if (resourceResolution === undefined) {
    const worldBound = descriptor.dataBinding === "WORLD_SNAPSHOT_BOUND" || descriptor.dataBinding === "DATASET_VERSION_BOUND";
    if (worldBound && descriptor.snapshotPolicy.dataSnapshot !== "REQUIRED") {
      issues.push(issue(`${path}/snapshotPolicy/dataSnapshot`, "snapshotPolicy", "data-bound operations require a Data Snapshot"));
    }
    if (!worldBound && descriptor.snapshotPolicy.dataSnapshot !== "NONE") {
      issues.push(issue(`${path}/snapshotPolicy/dataSnapshot`, "snapshotPolicy", "world-independent and caller-data operations must not create a Data Snapshot"));
    }
  } else if (resourceResolution === "DISCOVER_RESOURCES" || resourceResolution === "REQUIRE_PINNED") {
    if (descriptor.dataBinding === "WORLD_INDEPENDENT") {
      issues.push(issue(`${path}/snapshotPolicy/resourceResolution`, "resourceResolution", `${resourceResolution} requires a data-bound operation`));
    }
    if (descriptor.snapshotPolicy.dataSnapshot !== "REQUIRED") {
      issues.push(issue(`${path}/snapshotPolicy/dataSnapshot`, "resourceResolution", `${resourceResolution} requires a Data Snapshot`));
    }
  } else if (resourceResolution === "NOT_APPLICABLE") {
    if (descriptor.dataBinding !== "WORLD_INDEPENDENT") {
      issues.push(issue(`${path}/snapshotPolicy/resourceResolution`, "resourceResolution", "NOT_APPLICABLE is valid only for world-independent operations"));
    }
    if (descriptor.snapshotPolicy.dataSnapshot !== "NONE") {
      issues.push(issue(`${path}/snapshotPolicy/dataSnapshot`, "resourceResolution", "NOT_APPLICABLE requires dataSnapshot NONE"));
    }
  }
  if (descriptor.dataBinding === "WORLD_SNAPSHOT_BOUND" && descriptor.scopePolicy !== "DATA_SCOPE_REQUIRED") {
    issues.push(issue(`${path}/scopePolicy`, "scopePolicy", "world-snapshot operations require DATA_SCOPE_REQUIRED"));
  }
  if (descriptor.dataBinding === "DATASET_VERSION_BOUND" && descriptor.scopePolicy !== "DATASET_SCOPE_REQUIRED") {
    issues.push(issue(`${path}/scopePolicy`, "scopePolicy", "dataset-version operations require DATASET_SCOPE_REQUIRED"));
  }
  for (const direction of ["inputs", "outputs"] as const) {
    for (const duplicate of duplicateValues(descriptor.ports[direction].map((port) => port.name))) {
      issues.push(issue(`${path}/ports/${direction}`, "uniquePortName", `duplicates port name ${duplicate}`));
    }
  }
  descriptor.ports.inputs.forEach((port, index) => {
    if (port.path !== undefined) {
      issues.push(issue(`${path}/ports/inputs/${index}/path`, "outputSelector", "input ports must not declare an output selector path"));
    }
  });
  const outputPaths: string[] = [];
  descriptor.ports.outputs.forEach((port, index) => {
    if (port.name === "result") {
      if (port.path !== undefined) {
        issues.push(issue(`${path}/ports/outputs/${index}/path`, "outputSelector", "the result port must select the whole output"));
      }
      return;
    }
    if (port.path === undefined) {
      issues.push(issue(`${path}/ports/outputs/${index}/path`, "outputSelector", "named output subports require a controlled JSON Pointer path"));
      return;
    }
    const segments = targetSegments(port.path);
    if (segments.length > MAX_WORLD_QUERY_TARGET_DEPTH) {
      issues.push(issue(`${path}/ports/outputs/${index}/path`, "outputSelectorDepth", `must not exceed ${MAX_WORLD_QUERY_TARGET_DEPTH} object segments`));
    }
    if (segments.some(isUnsafeOrReservedWorldQuerySegment)) {
      issues.push(issue(`${path}/ports/outputs/${index}/path`, "unsafeOutputSelector", "contains a forbidden object segment"));
    }
    outputPaths.push(port.path);
  });
  for (const duplicate of duplicateValues(outputPaths)) {
    issues.push(issue(`${path}/ports/outputs`, "uniqueOutputSelector", `duplicates output selector ${duplicate}`));
  }
  if ((descriptor.maturity === "DEPRECATED" || descriptor.maturity === "RETIRED") && !descriptor.deprecation) {
    issues.push(issue(`${path}/deprecation`, "deprecation", `${descriptor.maturity} operations require deprecation metadata`));
  }
  return result(issues);
}

export function validateProviderManifestSemantics(
  manifest: CapabilityProviderManifest
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const keys = manifest.capabilities.map((capability) => `${capability.operationId}@${capability.operationVersion}`);
  for (const duplicate of duplicateValues(keys)) {
    issues.push(issue("/capabilities", "uniqueOperationVersion", `duplicates ${duplicate}`));
  }
  manifest.capabilities.forEach((descriptor, index) => {
    issues.push(...validateCapabilityDescriptorSemantics(descriptor, `/capabilities/${index}`).issues);
  });
  return result(issues);
}

export const validateSemanticManifest = validateProviderManifestSemantics;

export function validateOperationSchemaAttestation(
  operation: PlatformCommonDefinitionsOperationRef,
  descriptor: CapabilityDescriptor
): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (operation.operationId !== descriptor.operationId || operation.operationVersion !== descriptor.operationVersion) {
    issues.push(issue("/operation", "operationSelection", "does not match the selected operation ID/version"));
  }
  if (operation.inputSchemaHash !== descriptor.inputSchemaHash) {
    issues.push(issue("/operation/inputSchemaHash", "schemaHash", "does not match the selected input schema"));
  }
  if (operation.outputSchemaHash !== descriptor.outputSchemaHash) {
    issues.push(issue("/operation/outputSchemaHash", "schemaHash", "does not match the selected output schema"));
  }
  return result(issues);
}

export function validateCapabilityCatalogSemantics(catalog: CapabilityCatalog): ValidationResult {
  const issues: ValidationIssue[] = [];
  const endpoints = new Map(catalog.endpoints.map((endpoint) => [endpoint.endpointId, endpoint]));
  for (const duplicate of duplicateValues(catalog.endpoints.map((endpoint) => endpoint.endpointId))) {
    issues.push(issue("/endpoints", "uniqueEndpoint", `duplicates endpoint ${duplicate}`));
  }
  const registrationKeys = catalog.registrations.map(
    (entry) => `${entry.descriptor.operationId}@${entry.descriptor.operationVersion}/${entry.providerId}@${entry.providerVersion}`
  );
  for (const duplicate of duplicateValues(registrationKeys)) {
    issues.push(issue("/registrations", "uniqueRegistration", `duplicates registration ${duplicate}`));
  }
  catalog.registrations.forEach((entry, index) => {
    const endpoint = endpoints.get(entry.endpointId);
    if (!endpoint) {
      issues.push(issue(`/registrations/${index}/endpointId`, "endpointBinding", "does not reference a controlled endpoint"));
    } else if (entry.enabled && endpoint.approval.status !== "APPROVED") {
      issues.push(issue(`/registrations/${index}/enabled`, "endpointApproval", "cannot enable a non-approved endpoint"));
    }
    if (entry.enabled && (entry.descriptor.maturity === "PLANNED" || entry.descriptor.maturity === "RETIRED")) {
      issues.push(issue(`/registrations/${index}/enabled`, "maturityPolicy", `${entry.descriptor.maturity} operations cannot execute`));
    }
    issues.push(...validateCapabilityDescriptorSemantics(entry.descriptor, `/registrations/${index}/descriptor`).issues);
  });
  return result(issues);
}

export function validateProviderExecutionRequestSemantics(
  request: ProviderExecutionRequest
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const issuedAt = Date.parse(request.securityContext.scopeAttestation.issuedAt);
  const expiresAt = Date.parse(request.securityContext.scopeAttestation.expiresAt);
  const authenticatedAt = Date.parse(request.securityContext.authenticatedAt);
  const deadlineAt = Date.parse(request.executionPolicy.deadlineAt);
  if (expiresAt <= issuedAt) {
    issues.push(issue("/securityContext/scopeAttestation/expiresAt", "attestationWindow", "must be after issuedAt"));
  }
  if (authenticatedAt > issuedAt || authenticatedAt > expiresAt) {
    issues.push(issue("/securityContext/authenticatedAt", "attestationWindow", "must not be later than scope-attestation issuance"));
  }
  if (deadlineAt > expiresAt) {
    issues.push(issue("/executionPolicy/deadlineAt", "attestationWindow", "must not outlive the scope attestation"));
  }
  for (const [field, manifest] of [
    ["requestedSnapshot", request.requestedSnapshot],
    ["effectiveSnapshot", request.effectiveSnapshot]
  ] as const) {
    if (manifest !== undefined) {
      issues.push(...validateQuerySnapshotManifestHash(manifest, `/${field}`).issues);
    }
  }
  return result(issues);
}

export function validateQuerySnapshotManifestHash(
  manifest: GowmV071QuerySnapshotManifest,
  path = ""
): ValidationResult {
  const { manifestHash, ...canonicalManifest } = manifest;
  return result(manifestHash === canonicalSha256(canonicalManifest) ? [] : [
    issue(`${path}/manifestHash`, "manifestHash", "must match the canonical manifest without manifestHash")
  ]);
}

export function validateWorldQueryResultSemantics(value: WorldQueryResult): ValidationResult {
  const issues: ValidationIssue[] = [];
  issues.push(...validateQuerySnapshotManifestHash(value.snapshotManifest, "/snapshotManifest").issues);
  if ((value.requestedSnapshotManifest === undefined) !== (value.effectiveSnapshotManifest === undefined)) {
    issues.push(issue(
      "/requestedSnapshotManifest",
      "snapshotManifestPair",
      "requestedSnapshotManifest and effectiveSnapshotManifest must either both be present or both be absent"
    ));
  }
  if (value.requestedSnapshotManifest !== undefined) {
    issues.push(...validateQuerySnapshotManifestHash(value.requestedSnapshotManifest, "/requestedSnapshotManifest").issues);
  }
  if (value.effectiveSnapshotManifest !== undefined) {
    issues.push(...validateQuerySnapshotManifestHash(value.effectiveSnapshotManifest, "/effectiveSnapshotManifest").issues);
    if (canonicalSha256(value.snapshotManifest) !== canonicalSha256(value.effectiveSnapshotManifest)) {
      issues.push(issue("/snapshotManifest", "effectiveSnapshotAlias", "must equal effectiveSnapshotManifest when the latter is present"));
    }
  }
  return result(issues);
}

export function validateCapabilityResultSemantics(
  envelope: CapabilityResultEnvelope,
  descriptor?: CapabilityDescriptor
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const failed = envelope.status === "FAILED";
  if (failed && !envelope.error) issues.push(issue("/error", "resultStatus", "FAILED results require a PlatformError"));
  if (failed && envelope.output !== undefined) issues.push(issue("/output", "resultStatus", "FAILED results must not contain output"));
  if (!failed && envelope.error !== undefined) issues.push(issue("/error", "resultStatus", "non-failed results must not contain an error"));
  if (!failed && envelope.output === undefined) issues.push(issue("/output", "resultStatus", "non-failed results require output"));
  if (!failed && envelope.receipts.length === 0) issues.push(issue("/receipts", "receiptRequired", "completed computation requires an Execution Receipt"));

  const snapshotHash = canonicalSha256(envelope.computeSnapshot);
  const outputHash = envelope.output ? canonicalSha256(envelope.output.value) : undefined;
  envelope.receipts.forEach((receipt, index) => {
    if (receipt.computeSnapshotHash !== snapshotHash) {
      issues.push(issue(`/receipts/${index}/computeSnapshotHash`, "snapshotHash", "does not match the canonical Compute Snapshot hash"));
    }
    if (outputHash && receipt.outputHash !== outputHash) {
      issues.push(issue(`/receipts/${index}/outputHash`, "outputHash", "does not match the canonical output value hash"));
    }
    if (receipt.operationId !== envelope.operation.operationId || receipt.operationVersion !== envelope.operation.operationVersion) {
      issues.push(issue(`/receipts/${index}`, "operationIdentity", "does not identify the result operation"));
    }
    if (receipt.providerId !== envelope.execution.providerId || receipt.providerVersion !== envelope.execution.providerVersion) {
      issues.push(issue(`/receipts/${index}`, "providerIdentity", "does not identify the result provider"));
    }
    if (receipt.changes.typeChanged) {
      if (!receipt.changes.inputGeometryType || !receipt.changes.outputGeometryType) {
        issues.push(issue(`/receipts/${index}/changes`, "typeChange", "typeChanged requires input and output geometry types"));
      } else if (receipt.changes.inputGeometryType === receipt.changes.outputGeometryType) {
        issues.push(issue(`/receipts/${index}/changes`, "typeChange", "typeChanged types must differ"));
      }
    }
  });
  if (outputHash && envelope.execution.resultHash !== outputHash) {
    issues.push(issue("/execution/resultHash", "resultHash", "must match the canonical output value hash"));
  }
  if (envelope.computeSnapshot.operation.operationId !== envelope.operation.operationId ||
      envelope.computeSnapshot.operation.operationVersion !== envelope.operation.operationVersion) {
    issues.push(issue("/computeSnapshot/operation", "operationIdentity", "must identify the result operation"));
  }
  if (envelope.computeSnapshot.provider.providerId !== envelope.execution.providerId ||
      envelope.computeSnapshot.provider.providerVersion !== envelope.execution.providerVersion) {
    issues.push(issue("/computeSnapshot/provider", "providerIdentity", "must identify the result provider"));
  }
  if (envelope.dataSnapshot?.consistency === "PINNED" && envelope.dataSnapshot.resources.some((resource) => resource.pinning !== "PINNED")) {
    issues.push(issue("/dataSnapshot/resources", "pinnedSnapshot", "PINNED consistency requires every resource to be pinned"));
  }

  if (descriptor) {
    if (envelope.operation.operationId !== descriptor.operationId || envelope.operation.operationVersion !== descriptor.operationVersion) {
      issues.push(issue("/operation", "descriptorMatch", "does not match the selected capability descriptor"));
    }
    if (envelope.output && envelope.output.schemaHash !== descriptor.outputSchemaHash) {
      issues.push(issue("/output/schemaHash", "schemaHash", "does not match the selected output schema hash"));
    }
    if (envelope.computeSnapshot.schemas.inputSchemaHash !== descriptor.inputSchemaHash ||
        envelope.computeSnapshot.schemas.outputSchemaHash !== descriptor.outputSchemaHash) {
      issues.push(issue("/computeSnapshot/schemas", "schemaHash", "does not match selected operation schemas"));
    }
    if (descriptor.snapshotPolicy.dataSnapshot === "REQUIRED" && !envelope.dataSnapshot) {
      issues.push(issue("/dataSnapshot", "snapshotRequired", "the capability contract requires a Data Snapshot"));
    }
    if (descriptor.snapshotPolicy.dataSnapshot === "NONE" && envelope.dataSnapshot) {
      issues.push(issue("/dataSnapshot", "fakeDataSnapshot", "the capability contract forbids a Data Snapshot"));
    }
    if (descriptor.dataBinding === "WORLD_INDEPENDENT" && envelope.evidenceReferences.length > 0) {
      issues.push(issue("/evidenceReferences", "fakeEvidence", "world-independent computation must not create World Evidence"));
    }
  }
  return result(issues);
}

function dependenciesForBinding(binding: WorldQueryPlanV2InputBinding): string[] {
  return binding.kind === "NODE_OUTPUT" ? [binding.nodeId] : [];
}

const MAX_WORLD_QUERY_TARGET_DEPTH = 8;
const UNSAFE_WORLD_QUERY_TARGET_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const RESERVED_WORLD_QUERY_SECURITY_SEGMENTS = new Set([
  "securitycontext",
  "principalref",
  "authenticationmethod",
  "scopeattestation",
  "datascopeclaim",
  "datasetscopeclaim",
  "gatewaycontext",
  "gatewayid",
  "allowexperimental"
]);

function targetSegments(path: string): string[] {
  if (!path.startsWith("/")) return [];
  return path.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function isUnsafeOrReservedWorldQuerySegment(segment: string): boolean {
  const normalized = segment.toLowerCase();
  return UNSAFE_WORLD_QUERY_TARGET_SEGMENTS.has(normalized) ||
    RESERVED_WORLD_QUERY_SECURITY_SEGMENTS.has(normalized);
}

function isPrefixPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length <= right.length && left.every((segment, index) => right[index] === segment);
}

export function validateWorldQueryPlanSemantics(plan: WorldQueryPlanV2): ValidationResult {
  const issues: ValidationIssue[] = [];
  const nodeMap = new Map(plan.nodes.map((node) => [node.nodeId, node]));
  for (const duplicate of duplicateValues(plan.nodes.map((node) => node.nodeId))) {
    issues.push(issue("/nodes", "uniqueNodeId", `duplicates node ${duplicate}`));
  }
  if (plan.nodes.length > plan.budgets.maximumNodes) {
    issues.push(issue("/budgets/maximumNodes", "nodeBudget", "is below the actual node count"));
  }
  const dependencies = new Map<string, Set<string>>();
  plan.nodes.forEach((node, index) => {
    const nodeDependencies = new Set<string>();
    const inputEntries = Object.entries(node.inputs);
    const bindings = inputEntries.map(([, binding]) => binding);
    const wholeRequestBinding = inputEntries.length === 1 && inputEntries[0]?.[0] === "request";
    const targetPaths: Array<{ name: string; path: string; segments: string[] }> = [];
    for (const [name, binding] of inputEntries) {
      if (wholeRequestBinding && binding.targetPath !== undefined) {
        issues.push(issue(`/nodes/${index}/inputs/${name}/targetPath`, "targetPathMode", "is forbidden on a whole request binding"));
      }
      if (!wholeRequestBinding) {
        const path = binding.targetPath ?? `/${name}`;
        const segments = targetSegments(path);
        if (segments.length > MAX_WORLD_QUERY_TARGET_DEPTH) {
          issues.push(issue(`/nodes/${index}/inputs/${name}/targetPath`, "targetPathDepth", `must not exceed ${MAX_WORLD_QUERY_TARGET_DEPTH} object segments`));
        }
        if (segments.some(isUnsafeOrReservedWorldQuerySegment)) {
          issues.push(issue(`/nodes/${index}/inputs/${name}/targetPath`, "unsafeTargetPath", "contains a forbidden object segment"));
        }
        targetPaths.push({ name, path, segments });
      }
    }
    for (let left = 0; left < targetPaths.length; left += 1) {
      for (let right = left + 1; right < targetPaths.length; right += 1) {
        const a = targetPaths[left]!;
        const b = targetPaths[right]!;
        if (isPrefixPath(a.segments, b.segments) || isPrefixPath(b.segments, a.segments)) {
          issues.push(issue(
            `/nodes/${index}/inputs/${b.name}/targetPath`,
            "targetPathConflict",
            `conflicts with input ${a.name} (${a.path} versus ${b.path})`
          ));
        }
      }
    }
    for (const binding of bindings) dependenciesForBinding(binding).forEach((dependency) => nodeDependencies.add(dependency));
    for (const precondition of node.preconditions ?? []) {
      if (precondition.kind === "NODE_STATUS") nodeDependencies.add(precondition.nodeId);
      else {
        dependenciesForBinding(precondition.binding).forEach((dependency) => nodeDependencies.add(dependency));
        if (precondition.binding.targetPath !== undefined) {
          issues.push(issue(`/nodes/${index}/preconditions`, "targetPathMode", "targetPath is only valid for composite node inputs"));
        }
      }
    }
    dependencies.set(node.nodeId, nodeDependencies);
    for (const dependency of nodeDependencies) {
      if (!nodeMap.has(dependency)) issues.push(issue(`/nodes/${index}`, "nodeReference", `references unknown node ${dependency}`));
      if (dependency === node.nodeId) issues.push(issue(`/nodes/${index}`, "selfReference", "must not depend on itself"));
    }
    for (const [name, binding] of Object.entries(node.inputs)) {
      if (binding.kind === "NODE_OUTPUT" && binding.outputPort === "result" && binding.path === undefined) {
        const source = nodeMap.get(binding.nodeId);
        if (source && binding.port.schemaHash !== source.operation.outputSchemaHash) {
          issues.push(issue(`/nodes/${index}/inputs/${name}/port/schemaHash`, "typedPort", "does not match the source node output schema hash"));
        }
      }
    }
    if (node.failurePolicy === "SKIP_IF_PRECONDITION_FALSE" && (node.preconditions?.length ?? 0) === 0) {
      issues.push(issue(`/nodes/${index}/preconditions`, "preconditionRequired", "SKIP_IF_PRECONDITION_FALSE requires at least one precondition"));
    }
    for (const [budgetName, nodeValue, planValue] of [
      ["maximumRows", node.budget.maximumRows, plan.budgets.maximumRows],
      ["maximumCandidates", node.budget.maximumCandidates, plan.budgets.maximumCandidates],
      ["maximumOutputBytes", node.budget.maximumOutputBytes, plan.budgets.maximumOutputBytes],
      ["maximumExecutionMs", node.budget.maximumExecutionMs, plan.budgets.maximumExecutionMs]
    ] as const) {
      if (nodeValue > planValue) issues.push(issue(`/nodes/${index}/budget/${budgetName}`, "nodeBudget", "must not exceed the plan budget"));
    }
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const depths = new Map<string, number>();
  const visit = (nodeId: string): number => {
    if (visiting.has(nodeId)) {
      issues.push(issue("/nodes", "acyclic", `cycle includes ${nodeId}`));
      return 1;
    }
    if (visited.has(nodeId)) return depths.get(nodeId) ?? 1;
    visiting.add(nodeId);
    const depth = 1 + Math.max(0, ...[...(dependencies.get(nodeId) ?? [])].filter((id) => nodeMap.has(id)).map(visit));
    visiting.delete(nodeId);
    visited.add(nodeId);
    depths.set(nodeId, depth);
    return depth;
  };
  const maximumDepth = Math.max(...plan.nodes.map((node) => visit(node.nodeId)));
  if (maximumDepth > plan.budgets.maximumDepth) {
    issues.push(issue("/budgets/maximumDepth", "depthBudget", `is ${plan.budgets.maximumDepth}, but the DAG depth is ${maximumDepth}`));
  }
  for (const budgetName of ["maximumRows", "maximumCandidates", "maximumOutputBytes", "maximumExecutionMs"] as const) {
    const aggregate = plan.nodes.reduce((sum, node) => sum + node.budget[budgetName], 0);
    if (aggregate > plan.budgets[budgetName]) {
      issues.push(issue(`/budgets/${budgetName}`, "aggregateBudget", `is ${plan.budgets[budgetName]}, below the node aggregate ${aggregate}`));
    }
  }
  for (const duplicate of duplicateValues(plan.outputs.map((output) => output.name))) {
    issues.push(issue("/outputs", "uniqueOutputName", `duplicates output ${duplicate}`));
  }
  plan.outputs.forEach((output, index) => {
    const source = nodeMap.get(output.binding.nodeId);
    if (output.binding.targetPath !== undefined) {
      issues.push(issue(`/outputs/${index}/binding/targetPath`, "targetPathMode", "targetPath is only valid for composite node inputs"));
    }
    if (!source) issues.push(issue(`/outputs/${index}/binding/nodeId`, "nodeReference", "references an unknown node"));
    else if (output.binding.outputPort === "result" && output.binding.path === undefined && output.binding.port.schemaHash !== source.operation.outputSchemaHash) {
      issues.push(issue(`/outputs/${index}/binding/port/schemaHash`, "typedPort", "does not match the source node output schema hash"));
    }
  });
  return result(issues);
}

export function validateProviderLockSemantics(lock: ProviderLock): ValidationResult {
  const issues: ValidationIssue[] = [];
  for (const duplicate of duplicateValues(lock.providers.map((provider) => provider.providerKey))) {
    issues.push(issue("/providers", "uniqueProviderKey", `duplicates provider ${duplicate}`));
  }
  lock.providers.forEach((provider, index) => {
    if (provider.sourceKind === "GITHUB_COMMIT" && !provider.sourceGitCommit) {
      issues.push(issue(`/providers/${index}/sourceGitCommit`, "sourceDigest", "GITHUB_COMMIT requires a 40-character commit SHA"));
    }
    if (provider.sourceKind !== "GITHUB_COMMIT" && !provider.sourceSha256) {
      issues.push(issue(`/providers/${index}/sourceSha256`, "sourceDigest", `${provider.sourceKind} requires a 64-character SHA-256`));
    }
    if (provider.redistributionAllowed && provider.licenseStatus !== "APPROVED") {
      issues.push(issue(`/providers/${index}/redistributionAllowed`, "licensePolicy", "redistribution requires APPROVED license status"));
    }
  });
  return result(issues);
}

export function validateH3CellSetSemantics(envelope: H3CellSetEnvelope): ValidationResult {
  const issues: ValidationIssue[] = [];
  const approximate = envelope.semantics === "CENTER_CONTAINMENT_COVER" || envelope.semantics === "CANDIDATE_SET";
  if (approximate && (!envelope.candidateOnly || !envelope.exactVerificationRequired)) {
    issues.push(issue("", "h3Exactness", "cover/candidate H3 results must be candidate-only and require exact verification"));
  }
  if (!approximate && envelope.exactVerificationRequired) {
    issues.push(issue("/exactVerificationRequired", "h3Exactness", "exact verification is reserved for approximate candidate/cover semantics"));
  }
  return result(issues);
}

function isCanonicalPosition(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return false;
  if (!value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) return false;
  return value[0]! >= -180 && value[0]! <= 180 && value[1]! >= -90 && value[1]! <= 90;
}

function samePosition(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((coordinate, index) => coordinate === right[index]);
}

function validatePolygonCoordinates(value: unknown, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(value) || value.length === 0) return [issue(path, "canonicalPolygon", "requires at least one linear ring")];
  value.forEach((ring, ringIndex) => {
    const ringPath = `${path}/${ringIndex}`;
    if (!Array.isArray(ring) || ring.length < 4) {
      issues.push(issue(ringPath, "canonicalLinearRing", "requires at least four positions"));
      return;
    }
    const positions = ring as unknown[];
    positions.forEach((position, positionIndex) => {
      if (!isCanonicalPosition(position)) {
        issues.push(issue(`${ringPath}/${positionIndex}`, "epsg4326Position", "must be a finite EPSG:4326 position within longitude/latitude bounds"));
      }
    });
    const first = positions[0];
    const last = positions.at(-1);
    if (isCanonicalPosition(first) && isCanonicalPosition(last) && !samePosition(first, last)) {
      issues.push(issue(ringPath, "closedLinearRing", "first and last positions must be identical"));
    }
  });
  return issues;
}

export function validateRoadCoverageRequestSemantics(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return result(issues);
  const request = value as Record<string, unknown>;
  const area = request.area;
  if (area && typeof area === "object" && !Array.isArray(area)) {
    const geometry = area as Record<string, unknown>;
    if (geometry.type === "Polygon") {
      issues.push(...validatePolygonCoordinates(geometry.coordinates, "/area/coordinates"));
    } else if (geometry.type === "MultiPolygon") {
      if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
        issues.push(issue("/area/coordinates", "canonicalMultiPolygon", "requires at least one polygon"));
      } else {
        geometry.coordinates.forEach((polygon, index) => {
          issues.push(...validatePolygonCoordinates(polygon, `/area/coordinates/${index}`));
        });
      }
    }
  }
  const selection = request.selectionPolicy as Record<string, unknown> | undefined;
  if (selection?.serviceMode === "FIXED_DIRECTION" && selection.fixedDirectionSource === undefined) {
    issues.push(issue("/selectionPolicy/fixedDirectionSource", "fixedDirectionSource", "FIXED_DIRECTION requires an explicit direction source"));
  }
  if (selection?.mode !== "MANUAL_OBLIGATIONS" && selection?.manualObligations !== undefined) {
    issues.push(issue("/selectionPolicy/manualObligations", "manualObligations", "manual obligations are valid only in MANUAL_OBLIGATIONS mode"));
  }
  const alternatives = request.alternativePolicy as Record<string, unknown> | undefined;
  if (typeof alternatives?.minimumVerifiedCount === "number" && typeof alternatives.requestedCount === "number" &&
      alternatives.minimumVerifiedCount > alternatives.requestedCount) {
    issues.push(issue("/alternativePolicy/minimumVerifiedCount", "alternativeCount", "must not exceed requestedCount"));
  }
  return result(issues);
}

export function validateCoverageResultSetSemantics(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return result(issues);
  const resultSet = value as Record<string, unknown>;
  const referenceKey = resultSet.referenceKey as Record<string, unknown> | undefined;
  if (referenceKey?.kind !== "QUERY_RESULT") {
    issues.push(issue("/referenceKey/kind", "resultReferenceKind", "Coverage plan sets must use QUERY_RESULT"));
  }
  const alternatives = Array.isArray(resultSet.alternatives) ? resultSet.alternatives : [];
  alternatives.forEach((alternative, index) => {
    if (!alternative || typeof alternative !== "object" || Array.isArray(alternative)) return;
    const alternativeReference = (alternative as Record<string, unknown>).referenceKey as Record<string, unknown> | undefined;
    if (alternativeReference?.kind !== "DERIVED_REFERENCE") {
      issues.push(issue(`/alternatives/${index}/referenceKey/kind`, "alternativeReferenceKind", "Coverage alternatives must use DERIVED_REFERENCE"));
    }
  });
  return result(issues);
}

export function validateNamedContractSemantics(nameOrId: string, value: unknown): ValidationIssue[] {
  const normalized = nameOrId.toLowerCase();
  if (normalized.includes("road-coverage-request") || normalized === "roadcoveragerequest") {
    return validateRoadCoverageRequestSemantics(value).issues;
  }
  if (normalized.includes("coverage-result-set") || normalized === "coverageresultset") {
    return validateCoverageResultSetSemantics(value).issues;
  }
  if (normalized.includes("capability-provider-manifest") || normalized === "capabilityprovidermanifest") {
    return validateProviderManifestSemantics(value as CapabilityProviderManifest).issues;
  }
  if (normalized.includes("capability-catalog") || normalized === "capabilitycatalog") {
    return validateCapabilityCatalogSemantics(value as CapabilityCatalog).issues;
  }
  if (normalized.includes("provider-execution-request") || normalized === "providerexecutionrequest") {
    return validateProviderExecutionRequestSemantics(value as ProviderExecutionRequest).issues;
  }
  if (normalized.includes("query-snapshot-manifest") || normalized === "gowmv07querysnapshotmanifest") {
    return validateQuerySnapshotManifestHash(value as GowmV071QuerySnapshotManifest).issues;
  }
  if (normalized.includes("world-query-result") || normalized === "worldqueryresult") {
    return validateWorldQueryResultSemantics(value as WorldQueryResult).issues;
  }
  if (normalized.includes("capability-result-envelope") || normalized === "capabilityresultenvelope") {
    return validateCapabilityResultSemantics(value as CapabilityResultEnvelope).issues;
  }
  if (normalized.includes("world-query-plan-v2") || normalized === "worldqueryplanv2") {
    return validateWorldQueryPlanSemantics(value as WorldQueryPlanV2).issues;
  }
  if (normalized.includes("provider-lock") || normalized === "providerlock") {
    return validateProviderLockSemantics(value as ProviderLock).issues;
  }
  if (normalized.includes("h3-cell-set-envelope") || normalized === "h3cellsetenvelope") {
    return validateH3CellSetSemantics(value as H3CellSetEnvelope).issues;
  }
  return [];
}
