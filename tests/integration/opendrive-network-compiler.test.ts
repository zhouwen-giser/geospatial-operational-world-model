import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileOpenDriveArtifacts, localToGeographic } from "../../packages/opendrive-network-compiler/src/index.js";
import { loadOpenDriveAdmissionPlan, materializeAdmissionPlan } from "../../scripts/opendrive/admission-artifacts.js";

const sourcePath = process.env.OPENDRIVE_SOURCE_PATH;
const oraclePath = process.env.OPENDRIVE_GEOREF_ORACLE_PATH;
const available = Boolean(sourcePath && oraclePath && existsSync(sourcePath) && existsSync(oraclePath));

describe.skipIf(!available)("locked airport OpenDRIVE compiler", () => {
  it("matches the locked Python oracle for golden and deterministic vectors", async () => {
    const vectors = [[0, 0, 0], [111_320, 110_540, 10], [-438.135, 234.62530559201548, -2.25], [12.345, -67.89, 4.5]];
    const program = "import importlib.util,json,sys; spec=importlib.util.spec_from_file_location('oracle',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); print(json.dumps([module.world_to_gnss(*v) for v in json.loads(sys.argv[2])]))";
    const { stdout } = await promisify(execFile)("python3", ["-c", program, oraclePath!, JSON.stringify(vectors)]);
    const oracle = JSON.parse(stdout) as Array<[number, number, number]>;
    vectors.forEach((vector, index) => localToGeographic(vector as [number, number, number]).forEach((value, dimension) => expect(value).toBeCloseTo(oracle[index]![dimension]!, 12)));
  });
  it("produces exact topology counts and byte-identical output twice", async () => {
    const first = await mkdtemp(join(tmpdir(), "gowm-xodr-a-")); const second = await mkdtemp(join(tmpdir(), "gowm-xodr-b-"));
    const a = await compileOpenDriveArtifacts({ sourcePath: sourcePath!, oraclePath: oraclePath!, outputRoot: first });
    const b = await compileOpenDriveArtifacts({ sourcePath: sourcePath!, oraclePath: oraclePath!, outputRoot: second });
    expect(a.manifest.counts).toMatchObject({ physicalRoads: 40, activeDirectedChannels: 244, allowedDirectedTransitions: 336, drivableJunctionConnectors: 164, excludedNonDrivingConnectors: 60, quarantinedDrivingChannels: 2 });
    expect(a.manifest).toEqual(b.manifest); expect(a.fileHashes).toEqual(b.fileHashes);
    const names = [...Object.keys(a.files), "SHA256SUMS"];
    for (const name of names) expect(await readFile(join(first, name), "utf8")).toBe(await readFile(join(second, name), "utf8"));
    const report = JSON.parse(await readFile(join(first, "compile-report.json"), "utf8")) as { topology: { maximumSourceEndpointGapM: number; weakComponents: number[] } };
    expect(report.topology.maximumSourceEndpointGapM).toBe(0.0005670204118981209); expect(report.topology.weakComponents).toEqual([244, 1, 1]);
    const plan = await loadOpenDriveAdmissionPlan(first); const materialized = materializeAdmissionPlan(plan);
    expect(materialized.topology.edges).toHaveLength(244); expect(materialized.topology.arcs).toHaveLength(244); expect(materialized.turns.pairwiseRules).toHaveLength(336);
    expect(materialized.datasetReferenceKey).toBe(a.manifest.datasetReferenceKey); expect(materialized.datasetVersion).toBe(a.manifest.datasetVersionKey);
    expect(materialized.graphVersion).toBe(a.manifest.graphVersionKey); expect(materialized.graphContentHash).toBe(a.manifest.contentHash);
  });
});
