import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

it("archives tracked deployment files without local trees or private environment files", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "gowm-package-inventory-"));
  try {
    const safe = ["package.json", "artifacts/h3-bindings.mjs", ".env.example",
      ".env.world-platform.example", "services/example/.env.example", "services/example/source file.ts"];
    const excluded = [".env", ".env.backup", "services/example/.env", "services/example/.env.local",
      ".worktrees/old/.env", ".worktrees/old/private.txt", ".pnpm-store/cache.txt", "task-packages/private.txt",
      "services/example/dist/old.js", "services/example/node_modules/module.js", "output/old.tar.gz",
      "reports/stale.json", ".runtime/private.txt", "SHA256SUMS"];
    for (const path of [...safe, ...excluded]) {
      await mkdir(dirname(join(fixture, path)), { recursive: true });
      await writeFile(join(fixture, path), "synthetic packaging fixture\n");
    }
    const git = (args: string[]) => execFileSync("git", ["-C", fixture, ...args], { windowsHide: true, stdio: "pipe" });
    git(["init", "--quiet"]);
    git(["-c", "core.autocrlf=false", "add", "--force", "--all"]);
    await writeFile(join(fixture, "services/example/untracked-private.txt"), "synthetic untracked data\n");
    const inventory = execFileSync(process.execPath, [resolve("scripts/dev-deployment-inventory.mjs"), fixture]);
    expect(inventory.toString("utf8").split("\0").filter(Boolean)).toEqual(safe.toSorted());

    // Exercise GNU tar with the same options as the Linux packaging entrypoint.
    const tar = process.platform === "win32"
      ? join(process.env.ProgramFiles ?? "C:/Program Files", "Git/usr/bin/tar.exe") : "tar";
    const archive = execFileSync(tar, ["-cf", "-", "-C", fixture, "--null", "--verbatim-files-from", "--no-recursion", "-T", "-"], { input: inventory });
    const members = execFileSync(tar, ["-tf", "-"], { input: archive, encoding: "utf8" }).trim().split(/\r?\n/u);
    expect(members).toEqual(safe.toSorted());
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
