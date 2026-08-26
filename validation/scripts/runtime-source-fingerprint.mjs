import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const runtimeSourceRoots = ["database", "packages", "services", "contracts", "config", "scripts", "tests", "validation/fixtures", "validation/scripts", "validation/gowm-v0.6.1", "package.json", "package-lock.json", "tsconfig.json", "VERSION"];
export async function captureRuntimeSource(root) {
  const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...runtimeSourceRoots], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const files = {};
  for (const path of [...new Set(paths)].sort()) files[path] = createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
  return { roots: runtimeSourceRoots, files, digest: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}
export async function runtimeSourceFingerprint(root) { const source = await captureRuntimeSource(root); return { digest: source.digest, fileCount: Object.keys(source.files).length }; }
