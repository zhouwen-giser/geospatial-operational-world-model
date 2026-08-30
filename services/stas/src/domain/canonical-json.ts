import { createHash } from 'node:crypto';

// STAS is built as an independent deployment unit with rootDir=src. Keep the
// same Unicode code-point comparator locally instead of importing repository
// TypeScript sources across that compilation boundary.
function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  while (true) {
    const leftPoint = leftPoints.next();
    const rightPoint = rightPoints.next();
    if (leftPoint.done || rightPoint.done) {
      if (leftPoint.done && rightPoint.done) return 0;
      return leftPoint.done ? -1 : 1;
    }
    const difference = leftPoint.value.codePointAt(0)! - rightPoint.value.codePointAt(0)!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => compareUnicodeCodePoints(a, b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function semanticAnalysisHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}
