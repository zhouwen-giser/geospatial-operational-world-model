import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compileOpenDrivePaths, DEFAULT_OUTPUT_ROOT, type CompileResult } from "./compiler.js";
import { compareText, sha256 } from "./canonical.js";

export interface CompileOpenDriveArtifactsOptions { sourcePath: string; oraclePath: string; outputRoot?: string; }
export interface WrittenCompileResult extends CompileResult { outputRoot: string; fileHashes: Record<string, string>; }

export async function compileOpenDriveArtifacts(options: CompileOpenDriveArtifactsOptions): Promise<WrittenCompileResult> {
  const outputRoot = options.outputRoot ?? DEFAULT_OUTPUT_ROOT; const result = await compileOpenDrivePaths(options.sourcePath, options.oraclePath);
  await mkdir(outputRoot, { recursive: true });
  const fileHashes: Record<string, string> = {};
  for (const name of Object.keys(result.files).sort()) { const content = result.files[name]!; await writeFile(join(outputRoot, name), content, { encoding: "utf8", mode: 0o644 }); fileHashes[name] = sha256(content); }
  const sums = Object.entries(fileHashes).sort(([a], [b]) => compareText(a, b)).map(([name, hash]) => `${hash.slice(7)}  ${name}`).join("\n") + "\n";
  await writeFile(join(outputRoot, "SHA256SUMS"), sums, { encoding: "utf8", mode: 0o644 });
  return { ...result, outputRoot, fileHashes };
}
