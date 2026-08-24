import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules"]);

async function sourceFiles(directory: string): Promise<string[]> {
  const absolute = join(root, directory);
  try {
    const entries = await readdir(absolute);
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(absolute, entry);
      if ((await stat(path)).isDirectory()) {
        if (!ignoredDirectories.has(entry)) files.push(...await sourceFiles(relative(root, path)));
      }
      else if ([".ts", ".mts", ".js", ".mjs"].includes(extname(path))) files.push(path);
    }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

describe("GOWM v0.5 network/routing authority freeze", () => {
  it("records the single authority, immutable snapshot, scope, and non-reality boundaries", async () => {
    const policy = JSON.parse(await readFile(join(root, "config/network-routing-authority.json"), "utf8")) as Record<string, unknown>;
    expect(policy).toMatchObject({
      networkAuthority: "GOWM_NETWORK_FOUNDATION",
      graphElementIdentity: "GRAPH_VERSION_INTERNAL",
      graphVersionMutationPolicy: "APPEND_ONLY_IMMUTABLE",
      conditionPolicy: "VERSIONED_SNAPSHOT",
      providerCallPolicy: "NO_PROVIDER_TO_PROVIDER_CALLS",
      providerReadContract: "gowm_network_v1",
      graphBuildExposure: "PROTECTED_MANAGEMENT_ONLY",
      gatewayRoutingSemantics: "FORBIDDEN",
      routeResultKind: "QUERY_RESULT",
      routeRealitySemantics: "DERIVED_PLAN_NOT_EXECUTION_FACT",
      revalidationRequired: true
    });
    expect(policy.fixedPointUnits).toEqual([
      "distance_mm", "duration_ms", "risk_micro_units", "energy_mwh", "combined_cost_units"
    ]);
    expect(policy.scopeEnforcement).toEqual([
      "GATEWAY_TRUSTED_CONTEXT", "PROVIDER_TRANSACTION", "SQL_READ_CONTRACT"
    ]);
  });

  it("keeps routing SQL and algorithms out of the Gateway", async () => {
    const forbidden = /\b(?:pgr_[a-z0-9_]+|dijkstra|a\s*\*|product[-_ ]state|sequence[-_ ]automaton|routing_arc_projection|snap_candidates)\b/iu;
    const findings: string[] = [];
    for (const file of await sourceFiles("services/gateway")) {
      const content = await readFile(file, "utf8");
      if (forbidden.test(content)) findings.push(relative(root, file));
    }
    expect(findings).toEqual([]);
  });

  it("has no upper-layer runtime imports", async () => {
    const forbidden = /(?:from\s+["'][^"']*(?:wsgs|sacs|sdar|smpp|a2a)[^"']*["']|require\(["'][^"']*(?:wsgs|sacs|sdar|smpp|a2a)[^"']*["']\))/iu;
    const findings: string[] = [];
    for (const directory of ["packages", "services", "scripts", "simulator"]) {
      for (const file of await sourceFiles(directory)) {
        if (forbidden.test(await readFile(file, "utf8"))) findings.push(relative(root, file));
      }
    }
    expect(findings).toEqual([]);
  });
});
