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
  return validResourceId(`${referenceKey.namespace}:${referenceKey.id}`);
}

export function snapshotResourceIdFromDataset(datasetId: string): string {
  return validResourceId(`dataset:${datasetId}`);
}

export function snapshotResourceIdFromArtifact(artifactId: string): string {
  return validResourceId(`artifact:${artifactId}`);
}

export function snapshotResourceIdentity(resource: SnapshotResourceIdentityInput): string {
  const resourceKind = resource.resourceKind.trim();
  if (resourceKind.length === 0) throw new TypeError("snapshot resource kind must not be empty");
  return `${resourceKind}\u0000${validResourceId(resource.resourceId)}`;
}

function validResourceId(resourceId: string): string {
  if (resourceId.length === 0) throw new TypeError("snapshot resource id must not be empty");
  if (resourceId.length > SNAPSHOT_RESOURCE_ID_MAX_LENGTH) {
    throw new RangeError(`snapshot resource id exceeds ${SNAPSHOT_RESOURCE_ID_MAX_LENGTH} characters`);
  }
  return resourceId;
}
