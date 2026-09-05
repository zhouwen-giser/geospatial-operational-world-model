import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

it("materializes locked deployment text as LF even with core.autocrlf=true", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "gowm-checkout-lf-"));
  try {
    const text = Buffer.from("first line\nsecond line\n");
    const files = new Map([
      ["artifacts/h3-bindings.mjs", await readFile("artifacts/h3-bindings.mjs")],
      ["artifacts/h3-bindings.mjs.LICENSE", text],
      ["services/upstreams/geometry-tool-service/packages/geometry-core/src/core.ts", text],
      ["services/upstreams/crs-normalization-service/grids/README.md", text],
      ["packages/platform/world-gateway-contracts/bundle/MANIFEST.json", text],
      ["scripts/dev-deploy.sh", text],
      ["scripts/package-dev-deployment.sh", text],
      ["services/upstreams/crs-normalization-service/grids/binary.dat", Buffer.from([0, 13, 10, 255])]
    ]);
    await writeFile(join(fixture, ".gitattributes"), await readFile(".gitattributes"));
    for (const [path, bytes] of files) {
      await mkdir(dirname(join(fixture, path)), { recursive: true });
      await writeFile(join(fixture, path), bytes);
    }
    const git = (args: string[]) => execFileSync("git", ["-C", fixture, "-c", "core.autocrlf=true", ...args], { windowsHide: true, stdio: "pipe" });
    git(["init", "--quiet"]);
    git(["add", "--all"]);
    const checkout = join(fixture, "fresh");
    await mkdir(checkout);
    git(["checkout-index", "--all", `--prefix=${checkout.replaceAll("\\", "/")}/`]);
    for (const [path, expected] of files) {
      expect(await readFile(join(checkout, path)), path).toEqual(expected);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
