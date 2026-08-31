export type HistoricalReferenceKind =
  | "TASK_EXECUTION_INTERVAL"
  | "TASK_EXECUTION_EVENT_SET"
  | "TASK_EXECUTION_INTERVAL_INPUT_SET"
  | "TRACKLET_VERSION"
  | "TRACKLET_FINALIZATION"
  | "HISTORICAL_TRAJECTORY"
  | "HISTORY_INPUT_SET"
  | "HISTORY_METHOD_PROFILE";

/** A version-pinned reference as accepted by the public GOWM contracts. */
export interface VersionedReferenceKey<TKind extends string = string> {
  namespace: string;
  kind: TKind;
  id: string;
  version: string;
}

/** The logical identity of a reference, deliberately excluding its version pin. */
export interface LogicalReferenceKey<TKind extends string = string> {
  namespace: string;
  kind: TKind;
  id: string;
}

export interface HistoricalReferenceKey extends VersionedReferenceKey<HistoricalReferenceKind> {}

export interface HistoricalLogicalReferenceKey extends LogicalReferenceKey<HistoricalReferenceKind> {}

export function logicalReferenceKey<TKind extends string>(
  referenceKey: VersionedReferenceKey<TKind>
): LogicalReferenceKey<TKind> {
  return {
    namespace: referenceKey.namespace,
    kind: referenceKey.kind,
    id: referenceKey.id
  };
}

export function referenceIdentity(referenceKey: LogicalReferenceKey): string {
  return `${referenceKey.namespace}:${referenceKey.kind}:${referenceKey.id}`;
}

export function versionedReferenceIdentity(referenceKey: VersionedReferenceKey): string {
  return `${referenceIdentity(referenceKey)}@${referenceKey.version}`;
}
