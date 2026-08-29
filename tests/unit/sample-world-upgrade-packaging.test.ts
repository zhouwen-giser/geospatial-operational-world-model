import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Sample World upgrade proof packaging", () => {
  it("compiles every upgrade probe entrypoint invoked by the container", async () => {
    const [configuration, cli] = await Promise.all([
      readFile("tsconfig.json", "utf8"),
      readFile("scripts/sample-world/cli.ts", "utf8")
    ]);
    const includes = (JSON.parse(configuration) as { include?: string[] }).include ?? [];
    const sourceEntrypoint = "validation/scripts/gowm-v064-upgrade-probe.ts";
    const compiledEntrypoint = "dist/validation/scripts/gowm-v064-upgrade-probe.js";

    expect(includes).toContain(sourceEntrypoint);
    expect(cli.match(new RegExp(compiledEntrypoint.replaceAll(".", "\\."), "gu"))).toHaveLength(2);
  });
});
