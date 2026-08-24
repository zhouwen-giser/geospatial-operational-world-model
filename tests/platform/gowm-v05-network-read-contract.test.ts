import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("GOWM v0.5 network read contract", () => {
  it("exposes only the frozen scoped views and controlled functions", async () => {
    const sql = await readFile(resolve(root, "database/migrations/039_gowm_network_v1_read_contract.sql"), "utf8");
    for (const view of [
      "graph_version", "node", "edge", "arc", "turn_rule", "turn_sequence_rule",
      "travel_profile", "cost_profile", "arc_cost", "condition_snapshot", "arc_condition"
    ]) expect(sql).toContain(`CREATE VIEW gowm_network_v1.${view} WITH (security_barrier = true)`);
    for (const fn of ["set_scope", "resolve_active_graph", "resolve_routing_snapshot", "snap_candidates", "routing_arc_projection"]) {
      expect(sql).toContain(`FUNCTION gowm_network_v1.${fn}`);
    }
    expect(sql).toContain("graph.data_scope_key = gowm_network_v1.current_data_scope_key()");
    expect(sql).toContain("graph.dataset_scope_key = gowm_network_v1.current_dataset_scope_key()");
  });

  it("keeps Providers read-only and route projection exclusive to the route planner", async () => {
    const sql = await readFile(resolve(root, "database/migrations/039_gowm_network_v1_read_contract.sql"), "utf8");
    expect(sql).toContain("CREATE ROLE network_provider NOLOGIN INHERIT");
    expect(sql).toContain("CREATE ROLE route_planner_provider NOLOGIN INHERIT");
    expect(sql).toContain("ALTER ROLE network_provider SET default_transaction_read_only = on");
    expect(sql).toContain("ALTER ROLE route_planner_provider SET default_transaction_read_only = on");
    expect(sql).toContain("routing_arc_projection(uuid, uuid, uuid, uuid) TO route_planner_provider");
    expect(sql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*public\.network_/iu);
  });
});
