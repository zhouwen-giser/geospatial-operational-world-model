import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function migration(number: number, name: string): Promise<string> {
  return readFile(resolve(root, `database/migrations/${String(number).padStart(3, "0")}_${name}.sql`), "utf8");
}

describe("GOWM v0.5 network foundation schema", () => {
  it("adds the complete network foundation model after immutable migration 032", async () => {
    const sources = await Promise.all([
      migration(33, "network_graph_catalog"),
      migration(34, "network_topology"),
      migration(35, "network_turns_and_bindings"),
      migration(36, "network_profiles_and_costs"),
      migration(37, "network_conditions"),
      migration(38, "network_build_and_activation")
    ]);
    const sql = sources.join("\n");
    for (const table of [
      "network_graph", "network_graph_version", "network_node", "network_edge", "network_arc",
      "network_turn_rule", "network_turn_sequence_rule", "network_feature_binding",
      "network_travel_profile_version", "network_cost_profile_version", "network_arc_cost",
      "network_condition_snapshot", "network_arc_condition", "network_build_run",
      "network_validation_issue", "network_graph_activation_event"
    ]) expect(sql).toContain(`CREATE TABLE ${table}`);
  });

  it("enforces append-only versions and directed topology invariants", async () => {
    const graph = await migration(33, "network_graph_catalog");
    const topology = await migration(34, "network_topology");
    const turns = await migration(35, "network_turns_and_bindings");
    const profiles = await migration(36, "network_profiles_and_costs");
    expect(graph).toContain("network_graph_version_immutable");
    for (const trigger of ["network_node_immutable", "network_edge_immutable", "network_arc_immutable"]) {
      expect(topology).toContain(trigger);
    }
    expect(topology).toContain("parent_edge.oneway = 'FORWARD_ONLY'");
    expect(topology).toContain("arc geometry orientation does not match topology nodes");
    expect(turns).toContain("turn sequence arcs are not contiguous");
    expect(turns).toContain("network source feature binding is inconsistent");
    expect(profiles).toContain("distance_weight_ppm + duration_weight_ppm + risk_weight_ppm + energy_weight_ppm = 1000000");
  });

  it("keeps dynamic conditions separate and validates activation against immutable content", async () => {
    const conditions = await migration(37, "network_conditions");
    const activation = await migration(38, "network_build_and_activation");
    expect(conditions).toContain("CREATE TABLE network_arc_condition");
    expect(conditions).not.toMatch(/UPDATE\s+network_arc/iu);
    expect(activation).toContain("graph version counts do not match immutable content");
    expect(activation).toContain("edge without an authorized source binding");
    expect(activation).toContain("GRANT SELECT, INSERT ON network_graph");
    expect(activation).not.toContain("GRANT UPDATE");
  });
});
