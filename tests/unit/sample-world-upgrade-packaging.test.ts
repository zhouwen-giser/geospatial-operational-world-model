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

  it("keeps read-contract scopes alive across autonomous Pool queries", async () => {
    const probe = await readFile("validation/scripts/gowm-v064-upgrade-probe.ts", "utf8");

    expect(probe).toContain("set_config('gowm.data_scope_key','wsgs-demo',false)");
    expect(probe).toContain("set_config('gowm.data_scope_key','wsgs-hidden',false)");
    expect(probe.match(/gowm_evidence_v1\.set_data_scope/gu)).toHaveLength(1);
  });

  it("tests read-only writes against an explicitly qualified Foundation table", async () => {
    const probe = await readFile("validation/scripts/gowm-v064-upgrade-probe.ts", "utf8");

    expect(probe).toContain("INSERT INTO public.data_scope");
    expect(probe).not.toContain("INSERT INTO data_scope(");
  });

  it("keeps the multi-stage CLI alive until its command promise settles", async () => {
    const cli = await readFile("scripts/sample-world/cli.ts", "utf8");

    expect(cli).toContain("await runSampleWorldCommand(process.argv[2] ?? \"status\")");
    expect(cli).not.toContain("runSampleWorldCommand(process.argv[2] ?? \"status\").catch");
  });
});
