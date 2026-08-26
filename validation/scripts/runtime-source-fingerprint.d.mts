export const runtimeSourceRoots: string[];
export function captureRuntimeSource(root: string): Promise<{ roots: string[]; files: Record<string, string>; digest: string }>;
export function runtimeSourceFingerprint(root: string): Promise<{ digest: string; fileCount: number }>;
