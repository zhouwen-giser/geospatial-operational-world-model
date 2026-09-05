import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const excludedDirectories = new Set([
  ".git", ".worktrees", ".pnpm-store", "task-packages", ".codex", ".agents",
  ".runtime", ".intake", ".docker-config", "node_modules", "dist", "coverage"
]);
const tracked = execFileSync("git", ["-C", root, "ls-files", "--cached", "-z"], {
  encoding: "utf8", windowsHide: true
}).split("\0").filter(Boolean);
const inventory = [];
for (const path of [...new Set(tracked)].sort()) {
  const parts = path.split("/");
  const name = parts.at(-1);
  if (parts.some((part) => excludedDirectories.has(part))) continue;
  if (["reports", "output"].includes(parts[0]) || path === "SHA256SUMS") continue;
  if (name.startsWith(".env") && !name.endsWith(".example")) continue;
  if (/\.(?:log|pid|zip)$/iu.test(name)) continue;
  // Do not allow a tracked link, submodule, or a locally replaced directory to
  // redirect the inventory outside this checkout.
  for (let index = 0; index < parts.length; index += 1) {
    const stat = lstatSync(join(root, ...parts.slice(0, index + 1)));
    if (stat.isSymbolicLink() || (index === parts.length - 1 && !stat.isFile())) {
      throw new Error(`Deployment inventory requires regular files: ${path}`);
    }
  }
  inventory.push(path);
}
if (!inventory.includes("artifacts/h3-bindings.mjs")) {
  throw new Error("The verified H3 artifact must be tracked before packaging");
}
process.stdout.write(`${inventory.join("\0")}\0`);
