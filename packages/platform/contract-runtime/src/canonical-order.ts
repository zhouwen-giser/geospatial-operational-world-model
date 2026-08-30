/**
 * Locale-independent ordering for values that participate in contracts,
 * revisions, manifests, locks, and evidence digests.
 *
 * Deliberately does not normalize Unicode, fold case, or invoke locale APIs.
 */
export function compareUnicodeCodePoints(left: string, right: string): number {
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

export function canonicalSortStrings(values: readonly string[]): string[] {
  return [...values].sort(compareUnicodeCodePoints);
}

export function compareCanonicalJson(left: unknown, right: unknown): number {
  return compareUnicodeCodePoints(canonicalOrderJson(left), canonicalOrderJson(right));
}

function canonicalOrderJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Value is not JSON serializable");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalOrderJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${canonicalSortStrings(Object.keys(object))
    .map((key) => `${JSON.stringify(key)}:${canonicalOrderJson(object[key])}`)
    .join(",")}}`;
}
