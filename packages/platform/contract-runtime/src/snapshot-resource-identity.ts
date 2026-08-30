export const SNAPSHOT_RESOURCE_ID_MAX_LENGTH = 512;

export interface SnapshotReferenceKeyIdentity {
  namespace: string;
  id: string;
}

export interface SnapshotResourceIdentityInput {
  resourceKind: string;
  resourceId: string;
}

export function snapshotResourceIdFromReferenceKey(referenceKey: SnapshotReferenceKeyIdentity): string {
  if (!/^[a-z][a-z0-9_.-]{1,63}$/u.test(referenceKey.namespace)) {
    throw new TypeError("snapshot ReferenceKey namespace violates the canonical contract");
  }
  const idLength = [...referenceKey.id].length;
  if (idLength === 0 || idLength > 256) {
    throw new RangeError("snapshot ReferenceKey id must contain between 1 and 256 characters");
  }
  return validResourceId(`${referenceKey.namespace}:${referenceKey.id}`);
}

export function snapshotResourceIdFromDataset(datasetId: string): string {
  return validResourceId(`dataset:${validBoundedId(datasetId, "dataset")}`);
}

export function snapshotResourceIdFromArtifact(artifactId: string): string {
  return validResourceId(`artifact:${validBoundedId(artifactId, "artifact")}`);
}

export function snapshotResourceIdentity(resource: SnapshotResourceIdentityInput): string {
  const resourceKind = resource.resourceKind.trim();
  if (resourceKind.length === 0) throw new TypeError("snapshot resource kind must not be empty");
  return JSON.stringify([resourceKind, validResourceId(resource.resourceId)]);
}

/**
 * Returns the externally persisted form of a snapshot resource identity.
 *
 * A JSON tuple preserves both fields without choosing a delimiter that either
 * legal identity component could contain, and is safe inside PostgreSQL jsonb.
 */
export function snapshotResourceEvidenceIdentity(resource: SnapshotResourceIdentityInput): string {
  const resourceKind = resource.resourceKind.trim();
  if (resourceKind.length === 0) throw new TypeError("snapshot resource kind must not be empty");
  return JSON.stringify([resourceKind, validResourceId(resource.resourceId)]);
}
function validResourceId(resourceId: string): string {
  const codePointLength = [...resourceId].length;
  if (codePointLength === 0) throw new TypeError("snapshot resource id must not be empty");
  if (codePointLength > SNAPSHOT_RESOURCE_ID_MAX_LENGTH) {
    throw new RangeError(`snapshot resource id exceeds ${SNAPSHOT_RESOURCE_ID_MAX_LENGTH} characters`);
  }
  return resourceId;
}

function validBoundedId(value: string, kind: "dataset" | "artifact"): string {
  const length = [...value].length;
  if (length === 0 || length > 256) {
    throw new RangeError(`snapshot ${kind} id must contain between 1 and 256 characters`);
  }
  return value;
}
