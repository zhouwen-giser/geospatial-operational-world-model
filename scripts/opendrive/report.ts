import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export type AcceptanceStatus = "PASS" | "FAIL" | "NOT_RUN" | "BLOCKED";

export interface AcceptanceCheck {
  readonly id: string;
  readonly status: AcceptanceStatus;
  readonly summary: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export interface AcceptanceReport {
  readonly schemaVersion: "1.0";
  readonly reportKind: string;
  readonly status: AcceptanceStatus;
  readonly generatedAt: string;
  readonly checks: readonly AcceptanceCheck[];
  readonly summary: Readonly<Record<string, unknown>>;
}

export function aggregateStatus(checks: readonly AcceptanceCheck[]): AcceptanceStatus {
  if (checks.some((check) => check.status === "FAIL")) return "FAIL";
  if (checks.some((check) => check.status === "BLOCKED")) return "BLOCKED";
  if (checks.some((check) => check.status === "NOT_RUN")) return "NOT_RUN";
  return "PASS";
}

export async function writeAcceptanceReport(path: string, report: AcceptanceReport): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = resolve(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  await rename(temporary, target);
}

export function redactedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replaceAll(/postgres(?:ql)?:\/\/[^\s@/]+(?::[^\s@/]*)?@/giu, "postgresql://<redacted>@")
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, "Bearer <redacted>")
    .replaceAll(/\/home\/[A-Za-z0-9._/-]+/gu, "<host-path>");
}
