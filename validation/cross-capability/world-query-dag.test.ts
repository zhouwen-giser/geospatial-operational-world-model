import { describe, expect, it } from "vitest";
import type {
  CapabilityDescriptor,
  WorldQueryPlanV2InputBinding,
  WorldQueryPlanV2Node,
  WorldQueryPlanV2SchemaPort,
  WorldQueryResult,
  WorldQuerySubmission
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  getContractSchemaHash,
  validateContract
} from "../../packages/platform/contract-runtime/src/index.js";
import type { GatewayPrincipal } from "../../services/gateway/world-capability-gateway/src/index.js";
import {
  createCrossCapabilityHarness,
  FILTERED_WORLD_REFERENCE,
  projectedPolygon,
  projectedPosition,
  TOKYO_CELL,
  TOKYO_NEIGHBOR,
  WORLD_REFERENCE,
  type CrossCapabilityHarness
} from "./fixtures.js";

const VALID_AREA = [
  [116.3, 39.8],
  [116.5, 39.8],
  [116.5, 40.0],
  [116.3, 40.0],
  [116.3, 39.8]
] as const;

const INVALID_BOW_TIE = [
  [116.3, 39.8],
  [116.5, 40.0],
  [116.5, 39.8],
  [116.3, 40.0],
  [116.3, 39.8]
] as const;

const principal: GatewayPrincipal = {
  principalRef: "principal:p13-cross-capability",
  authenticationMethod: "CONTROLLED_IN_PROCESS_ATTESTATION",
  authenticatedAt: new Date(Date.now() - 60_000).toISOString(),
  dataScopeClaim: "default",
  allowExperimental: true
};

const parameterSchemaHash = getContractSchemaHash("world-query-parameters.schema.json");

describe("P13 cross-capability World Query DAG", () => {
  it("AC-071 normalizes a projected point before a scoped Spatial nearby query", async () => {
    const test = createCrossCapabilityHarness();
    const crs = test.descriptor("crs.normalize.point");
    const nearby = test.descriptor("spatial.find-nearby");
    const nodes = [
      node("normalizePoint", crs, {
        sourceCrs: requestPath("/point/sourceCrs", stringPort()),
        coordinate: requestPath("/point/coordinate", arrayPort("POSITION", "UNSPECIFIED"))
      }),
      node("nearby", nearby, {
        location: nodePath("normalizePoint", "/coordinate", arrayPort("POSITION", "ANGULAR_DEGREES")),
        radiusM: requestPath("/radiusM", numberPort("LINEAR_METERS")),
        limit: literal(10, integerPort())
      })
    ];
    const submission = query("p13_ac071_crs_nearby", nodes, {
      point: { sourceCrs: "EPSG:3857", coordinate: projectedPosition(116.4, 39.9) },
      radiusM: 1_000
    }, [wholeOutput("objects", "nearby", nearby)]);

    const executed = await test.runtime.submit(submission, principal);

    expect(executed.result).toMatchObject({
      status: "COMPLETED",
      outputs: { objects: { objects: [expect.objectContaining({ referenceKey: WORLD_REFERENCE })] } }
    });
    expect(test.spatialPool.operationQueries()).toHaveLength(1);
    expect(test.spatialPool.operationQueries()[0]?.text).toContain("ST_DWithin");
    expect(test.spatialPool.operationQueries()[0]?.values.slice(0, 2)).toEqual([116.4, 39.9]);
    expect(test.spatialPool.scopeClaims()).toEqual(["default"]);
    expect(nodeEnvelope(executed.result!, "normalizePoint").dataSnapshot).toBeUndefined();
    expect(nodeEnvelope(executed.result!, "nearby")).toMatchObject({
      dataSnapshot: { consistency: "CONSISTENT_AT_START" },
      evidenceReferences: [expect.objectContaining({ referenceKey: WORLD_REFERENCE })]
    });
  });

  it("AC-072 runs CRS polygon normalization, immutable validation, then exact in-area", async () => {
    const test = createCrossCapabilityHarness();
    const crs = test.descriptor("crs.normalize.geometry");
    const validate = test.descriptor("geometry.validate");
    const inArea = test.descriptor("spatial.find-in-area");
    const nodes = polygonValidationNodes(test, VALID_AREA, inArea);
    const submission = query("p13_ac072_polygon_in_area", nodes, {
      area: { sourceCrs: "EPSG:3857", geometry: projectedPolygon(VALID_AREA) }
    }, [wholeOutput("objects", "exactInArea", inArea)]);

    const executed = await test.runtime.submit(submission, principal);
    const validation = nodeEnvelope(executed.result!, "validateGeometry");

    expect(executed.result).toMatchObject({ status: "COMPLETED" });
    expect(validation.output?.value).toMatchObject({ valid: true, repairApplied: false });
    expect(validation.receipts[0]?.changes).toMatchObject({ repairApplied: false, typeChanged: false });
    expect(test.spatialPool.operationQueries()).toHaveLength(1);
    expect(test.spatialPool.operationQueries()[0]?.text).toContain("ST_Covers");
    expect(nodeEnvelope(executed.result!, "normalizeGeometry").computeSnapshot.engine).toMatchObject({ name: "PROJ", version: "9.5.1" });
    expect(nodeEnvelope(executed.result!, "exactInArea").computeSnapshot.engine).toMatchObject({ name: "PostGIS", version: "3.6.4" });
    expect(crs.inputSchemaHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(validate.outputSchemaHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("AC-073 stops an invalid geometry before the downstream Spatial query", async () => {
    const test = createCrossCapabilityHarness();
    const inArea = test.descriptor("spatial.find-in-area");
    const nodes = polygonValidationNodes(test, INVALID_BOW_TIE, inArea);
    const submission = query("p13_ac073_invalid_stop", nodes, {
      area: { sourceCrs: "EPSG:3857", geometry: projectedPolygon(INVALID_BOW_TIE) }
    }, [wholeOutput("objects", "exactInArea", inArea)]);

    const executed = await test.runtime.submit(submission, principal);

    expect(nodeEnvelope(executed.result!, "validateGeometry").output?.value).toMatchObject({
      valid: false,
      repairApplied: false,
      issues: ["Self-intersection"]
    });
    expect(nodeResult(executed.result!, "exactInArea")).toMatchObject({ status: "SKIPPED", attempt: 0 });
    expect(executed.result).toMatchObject({ status: "PARTIAL", outputs: {} });
    expect(test.spatialPool.operationQueries()).toHaveLength(0);
  });

  it("AC-074 repairs only through an explicit make-valid node, revalidates, and queries", async () => {
    const test = createCrossCapabilityHarness();
    const crs = test.descriptor("crs.normalize.geometry");
    const validate = test.descriptor("geometry.validate");
    const makeValid = test.descriptor("geometry.make-valid");
    const inArea = test.descriptor("spatial.find-in-area");
    const normalizedInvalid = {
      type: "Polygon" as const,
      coordinates: [INVALID_BOW_TIE.map(([longitude, latitude]) => [longitude, latitude])]
    };
    const nodes = [
      node("normalizeGeometry", crs, {
        sourceCrs: requestPath("/area/sourceCrs", stringPort()),
        geometry: requestPath("/area/geometry", geometryPort())
      }),
      node("validateBefore", validate, {
        geometry: nodePath("normalizeGeometry", "/geometry", geometryPort())
      }),
      guardedNode("makeValid", makeValid, {
        repairGeometry: nodePath(
          "normalizeGeometry",
          "/geometry",
          geometryPort(),
          "/input/geometry"
        ),
        repairCoordinateSpace: literal(
          "EPSG:4326",
          coordinateSpacePort(),
          "/input/coordinateSpace"
        ),
        repairCoordinateLayout: literal(
          "XY",
          coordinateLayoutPort(),
          "/input/coordinateLayout"
        )
      }, [valueEquals("validateBefore", "/valid", booleanPort(), false)]),
      guardedNode("normalizeRepairedGeometry", crs, {
        sourceCrs: literal("EPSG:4326", stringPort()),
        geometry: nodePath("makeValid", "/geometry", geometryUnspecifiedPort())
      }, [nodeCompleted("makeValid")]),
      guardedNode("validateAfter", validate, {
        geometry: nodePath("normalizeRepairedGeometry", "/geometry", geometryPort())
      }, [nodeCompleted("normalizeRepairedGeometry")]),
      guardedNode("exactInArea", inArea, {
        geometry: nodePath("normalizeRepairedGeometry", "/geometry", geometryPort()),
        limit: literal(10, integerPort())
      }, [valueEquals("validateAfter", "/valid", booleanPort(), true)])
    ];
    const submission = query("p13_ac074_explicit_repair", nodes, {
      area: { sourceCrs: "EPSG:3857", geometry: projectedPolygon(INVALID_BOW_TIE) }
    }, [
      wholeOutput("objects", "exactInArea", inArea),
      nodePathOutput("repairedGeometry", "normalizeRepairedGeometry", "/geometry", geometryPort())
    ]);

    const executed = await test.runtime.submit(submission, principal);
    const normalized = nodeEnvelope(executed.result!, "normalizeGeometry");
    const before = nodeEnvelope(executed.result!, "validateBefore");
    const repaired = nodeEnvelope(executed.result!, "makeValid");
    const after = nodeEnvelope(executed.result!, "validateAfter");

    expect((normalized.output?.value as { geometry: unknown }).geometry).toEqual(normalizedInvalid);
    expect(submission.parameters).not.toHaveProperty("repairOperand");
    expect(submission.plan.nodes.find((entry) => entry.nodeId === "makeValid")?.inputs).toMatchObject({
      repairGeometry: {
        kind: "NODE_OUTPUT",
        nodeId: "normalizeGeometry",
        path: "/geometry",
        targetPath: "/input/geometry"
      },
      repairCoordinateSpace: { kind: "LITERAL", value: "EPSG:4326", targetPath: "/input/coordinateSpace" },
      repairCoordinateLayout: { kind: "LITERAL", value: "XY", targetPath: "/input/coordinateLayout" }
    });
    expect(before.output?.value).toMatchObject({ valid: false, repairApplied: false });
    expect(repaired.output?.value).toMatchObject({ geometry: { type: "MultiPolygon" } });
    expect(repaired.receipts[0]?.changes).toEqual({
      repairApplied: true,
      typeChanged: true,
      inputGeometryType: "Polygon",
      outputGeometryType: "MultiPolygon"
    });
    expect(after.output?.value).toMatchObject({ valid: true, repairApplied: false });
    expect(nodeResult(executed.result!, "exactInArea").status).toBe("COMPLETED");
    expect(executed.result?.status).toBe("COMPLETED");
    expect(test.spatialPool.operationQueries()).toHaveLength(1);
  });

  it("AC-075 uses H3 only for candidates and Spatial for exact world filtering", async () => {
    const test = createCrossCapabilityHarness();
    const crs = test.descriptor("crs.normalize.geometry");
    const validate = test.descriptor("geometry.validate");
    const cover = test.descriptor("h3.geometry.cover");
    const situation = test.descriptor("gowm.situation.h3.get-cell");
    const exact = test.descriptor("spatial.find-intersections");
    const nodes = [
      node("normalizeGeometry", crs, {
        sourceCrs: requestPath("/area/sourceCrs", stringPort()),
        geometry: requestPath("/area/geometry", geometryPort())
      }),
      node("validateGeometry", validate, {
        geometry: nodePath("normalizeGeometry", "/geometry", geometryPort())
      }),
      guardedNode("candidateCover", cover, {
        geometry: nodePath("normalizeGeometry", "/geometry", geometryPort()),
        resolution: literal(9, integerPort())
      }, [valueEquals("validateGeometry", "/valid", booleanPort(), true)]),
      guardedNode("situationCandidates", situation, {
        cells: nodePath("candidateCover", "/cells", arrayPort("H3_CELL_SET", "DISCRETE"))
      }, [
        valueEquals("candidateCover", "/candidateOnly", booleanPort(), true),
        valueEquals("candidateCover", "/exactVerificationRequired", booleanPort(), true)
      ]),
      guardedNode("exactIntersections", exact, {
        geometry: nodePath("normalizeGeometry", "/geometry", geometryPort()),
        candidateReferences: nodePath("situationCandidates", "/references", arrayPort("ROW_SET", "DISCRETE")),
        limit: literal(10, integerPort())
      }, [
        valueEquals("validateGeometry", "/valid", booleanPort(), true),
        valueEquals("situationCandidates", "/candidateOnly", booleanPort(), true),
        valueEquals("situationCandidates", "/exactVerificationRequired", booleanPort(), true)
      ])
    ];
    const submission = query("p13_ac075_h3_candidate_exact", nodes, {
      area: { sourceCrs: "EPSG:3857", geometry: projectedPolygon(VALID_AREA) }
    }, [
      nodePathOutput("h3Cells", "candidateCover", "/cells", arrayPort("H3_CELL_SET", "DISCRETE")),
      nodePathOutput("candidateReferences", "situationCandidates", "/references", arrayPort("ROW_SET", "DISCRETE")),
      wholeOutput("exactObjects", "exactIntersections", exact)
    ]);

    const executed = await test.runtime.submit(submission, principal);
    const coverEnvelope = nodeEnvelope(executed.result!, "candidateCover");
    const situationEnvelope = nodeEnvelope(executed.result!, "situationCandidates");
    const exactEnvelope = nodeEnvelope(executed.result!, "exactIntersections");
    const situationValue = situationEnvelope.output?.value as Record<string, unknown>;
    const exactValue = exactEnvelope.output?.value as { objects: Array<{ referenceKey: unknown }> };

    expect(executed.result?.status).toBe("COMPLETED");
    expect(coverEnvelope.output?.value).toMatchObject({
      cells: expect.arrayContaining([TOKYO_CELL, TOKYO_NEIGHBOR]),
      semantics: "CENTER_CONTAINMENT_COVER",
      candidateOnly: true,
      exactVerificationRequired: true
    });
    expect(coverEnvelope.dataSnapshot).toBeUndefined();
    expect(coverEnvelope.evidenceReferences).toEqual([]);
    expect(situationValue).toMatchObject({
      references: expect.arrayContaining([WORLD_REFERENCE, FILTERED_WORLD_REFERENCE]),
      candidateOnly: true,
      exactVerificationRequired: true,
      worldVersion: 7
    });
    expect(situationEnvelope.dataSnapshot).toMatchObject({ consistency: "BEST_EFFORT" });
    expect(exactValue.objects.map((entry) => entry.referenceKey)).toEqual([WORLD_REFERENCE]);
    expect(exactEnvelope.dataSnapshot).toMatchObject({ consistency: "CONSISTENT_AT_START" });
    expect(exactEnvelope.evidenceReferences).toEqual([
      expect.objectContaining({ referenceKey: WORLD_REFERENCE, evidenceType: "CURRENT_PROJECTION_SOURCE" })
    ]);
    expect(test.situationPort.calls.filter((call) => call.method === "candidateReferences")).toEqual([
      expect.objectContaining({ dataScopeKey: "default", indexes: expect.arrayContaining([TOKYO_CELL, TOKYO_NEIGHBOR]) })
    ]);
    const exactQuery = test.spatialPool.operationQueries().find((call) => call.text.includes("spatial.find-intersections"));
    expect(exactQuery?.text).toContain("ST_Intersects");
    expect(exactQuery?.text).toContain("jsonb_array_elements");
    const candidateParameter = exactQuery?.values.find((value) => typeof value === "string" && value.includes(WORLD_REFERENCE.id));
    expect(JSON.parse(String(candidateParameter))).toEqual(expect.arrayContaining([WORLD_REFERENCE, FILTERED_WORLD_REFERENCE]));
    expect(test.spatialPool.scopeClaims()).toEqual(["default"]);
    expect(executed.result?.nodes.every((entry) =>
      entry.status !== "COMPLETED" || Boolean(entry.inputHash && entry.outputHash && entry.result?.computeSnapshot)
    )).toBe(true);
  });

  it("keeps tracklet sequences isolated across an explicit UNKNOWN gap before H3 flow", async () => {
    const test = createCrossCapabilityHarness();
    const flow = test.descriptor("h3.analytics.flow");
    const flowRequest = {
      trajectories: [
        {
          sequenceId: "tracklet-before-unknown-gap",
          points: [
            { longitude: 139.70, latitude: 35.60, timestamp: "2026-08-23T00:00:00.000Z" },
            { longitude: 139.71, latitude: 35.61, timestamp: "2026-08-23T00:00:10.000Z" }
          ]
        },
        {
          sequenceId: "tracklet-after-unknown-gap",
          points: [
            { longitude: 140.00, latitude: 35.80, timestamp: "2026-08-23T00:10:00.000Z" },
            { longitude: 140.01, latitude: 35.81, timestamp: "2026-08-23T00:10:10.000Z" }
          ]
        }
      ],
      resolution: 9,
      directed: true
    };
    const nodes = [node("h3Flow", flow, {
      request: requestPath("/flow", schemaPort(flow.ports.inputs[0]!))
    })];
    const submission = query("p13_tracklet_h3_flow", nodes, {
      flow: flowRequest,
      gap: { kind: "UNKNOWN", from: "2026-08-23T00:00:10.000Z", to: "2026-08-23T00:10:00.000Z" }
    }, [wholeOutput("flow", "h3Flow", flow)]);

    const executed = await test.runtime.submit(submission, principal);
    const upstreamCall = test.h3Upstream.calls.find((call) => call.operationId === "h3.analytics.flow");

    expect(executed.result).toMatchObject({
      status: "COMPLETED",
      outputs: { flow: { gapPolicy: "SEQUENCE_ISOLATED", directed: true, resolution: 9 } }
    });
    expect(upstreamCall?.input).toMatchObject({
      trajectories: [flowRequest.trajectories[0]!.points, flowRequest.trajectories[1]!.points]
    });
    expect((upstreamCall?.input as { trajectories: unknown[] }).trajectories).toHaveLength(2);
    expect(nodeEnvelope(executed.result!, "h3Flow").dataSnapshot).toBeUndefined();
    expect(nodeEnvelope(executed.result!, "h3Flow").evidenceReferences).toEqual([]);
  });
});

function polygonValidationNodes(
  test: CrossCapabilityHarness,
  _coordinates: readonly (readonly [number, number])[],
  inArea: CapabilityDescriptor
): WorldQueryPlanV2Node[] {
  const crs = test.descriptor("crs.normalize.geometry");
  const validate = test.descriptor("geometry.validate");
  return [
    node("normalizeGeometry", crs, {
      sourceCrs: requestPath("/area/sourceCrs", stringPort()),
      geometry: requestPath("/area/geometry", geometryPort())
    }),
    node("validateGeometry", validate, {
      geometry: nodePath("normalizeGeometry", "/geometry", geometryPort())
    }),
    guardedNode("exactInArea", inArea, {
      geometry: nodePath("normalizeGeometry", "/geometry", geometryPort()),
      limit: literal(10, integerPort())
    }, [valueEquals("validateGeometry", "/valid", booleanPort(), true)])
  ];
}

function node(
  nodeId: string,
  descriptor: CapabilityDescriptor,
  inputs: Record<string, WorldQueryPlanV2InputBinding>
): WorldQueryPlanV2Node {
  return {
    nodeId,
    operation: operation(descriptor),
    inputs,
    failurePolicy: "FAIL_FAST",
    budget: nodeBudget()
  };
}

function guardedNode(
  nodeId: string,
  descriptor: CapabilityDescriptor,
  inputs: Record<string, WorldQueryPlanV2InputBinding>,
  preconditions: NonNullable<WorldQueryPlanV2Node["preconditions"]>
): WorldQueryPlanV2Node {
  return {
    ...node(nodeId, descriptor, inputs),
    failurePolicy: "SKIP_IF_PRECONDITION_FALSE",
    preconditions
  };
}

function operation(descriptor: CapabilityDescriptor) {
  return {
    operationId: descriptor.operationId,
    operationVersion: descriptor.operationVersion,
    inputSchemaHash: descriptor.inputSchemaHash,
    outputSchemaHash: descriptor.outputSchemaHash
  };
}

function nodeBudget() {
  return {
    maximumRows: 100,
    maximumCandidates: 100,
    maximumOutputBytes: 1_000_000,
    maximumExecutionMs: 5_000
  };
}

function query(
  queryId: string,
  nodes: WorldQueryPlanV2Node[],
  parameters: Record<string, unknown>,
  outputs: WorldQuerySubmission["plan"]["outputs"]
): WorldQuerySubmission {
  const perNode = nodeBudget();
  const submission: WorldQuerySubmission = {
    requestId: `request:${queryId}`,
    idempotencyKey: `idempotency:${queryId}`,
    parameterSchemaHash,
    parameters,
    plan: {
      queryPlanVersion: "2.0",
      queryId,
      nodes,
      outputs,
      budgets: {
        maximumNodes: nodes.length,
        maximumDepth: nodes.length,
        maximumRows: nodes.length * perNode.maximumRows,
        maximumCandidates: nodes.length * perNode.maximumCandidates,
        maximumOutputBytes: nodes.length * perNode.maximumOutputBytes,
        maximumExecutionMs: nodes.length * perNode.maximumExecutionMs
      }
    }
  };
  expect(validateContract("world-query-submission.schema.json", submission)).toMatchObject({ valid: true });
  return submission;
}

function requestPath(
  path: string,
  port: WorldQueryPlanV2SchemaPort,
  targetPath?: string
): WorldQueryPlanV2InputBinding {
  return { kind: "REQUEST_PATH", path, port, ...(targetPath === undefined ? {} : { targetPath }) };
}

function literal(
  value: unknown,
  port: WorldQueryPlanV2SchemaPort,
  targetPath?: string
): WorldQueryPlanV2InputBinding {
  return { kind: "LITERAL", value, port, ...(targetPath === undefined ? {} : { targetPath }) };
}

function nodePath(
  nodeId: string,
  path: string,
  port: WorldQueryPlanV2SchemaPort,
  targetPath?: string,
  outputPort = outputPortForPath(path)
): WorldQueryPlanV2InputBinding {
  return {
    kind: "NODE_OUTPUT",
    nodeId,
    outputPort,
    path,
    port,
    ...(targetPath === undefined ? {} : { targetPath })
  };
}

function valueEquals(
  nodeId: string,
  path: string,
  port: WorldQueryPlanV2SchemaPort,
  value: unknown
): NonNullable<WorldQueryPlanV2Node["preconditions"]>[number] {
  return { kind: "VALUE_EQUALS", binding: nodePath(nodeId, path, port), value };
}

function nodeCompleted(nodeId: string): NonNullable<WorldQueryPlanV2Node["preconditions"]>[number] {
  return { kind: "NODE_STATUS", nodeId, statuses: ["COMPLETED"] };
}

function wholeOutput(
  name: string,
  nodeId: string,
  descriptor: CapabilityDescriptor
): WorldQuerySubmission["plan"]["outputs"][number] {
  return {
    name,
    binding: {
      kind: "NODE_OUTPUT",
      nodeId,
      outputPort: "result",
      port: schemaPort(descriptor.ports.outputs[0]!)
    }
  };
}

function nodePathOutput(
  name: string,
  nodeId: string,
  path: string,
  port: WorldQueryPlanV2SchemaPort
): WorldQuerySubmission["plan"]["outputs"][number] {
  return { name, binding: { kind: "NODE_OUTPUT", nodeId, outputPort: outputPortForPath(path), path, port } };
}

function outputPortForPath(path: string): string {
  const segment = path.split("/").at(-1);
  if (!segment) throw new Error(`fixture output path ${path} has no named selector`);
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function schemaPort(port: CapabilityDescriptor["ports"]["inputs"][number]): WorldQueryPlanV2SchemaPort {
  return {
    schemaUri: port.schemaUri,
    schemaHash: port.schemaHash,
    valueKind: port.valueKind,
    unitSemantics: port.unitSemantics
  };
}

function canonicalPort(
  schemaUri: string,
  valueKind: WorldQueryPlanV2SchemaPort["valueKind"],
  unitSemantics: WorldQueryPlanV2SchemaPort["unitSemantics"]
): WorldQueryPlanV2SchemaPort {
  return { schemaUri, schemaHash: getContractSchemaHash(schemaUri), valueKind, unitSemantics };
}

function geometryPort(): WorldQueryPlanV2SchemaPort {
  return canonicalPort("urn:gowm:capability:geometry:geojson-geometry:1.0", "GEOMETRY", "ANGULAR_DEGREES");
}

function geometryUnspecifiedPort(): WorldQueryPlanV2SchemaPort {
  return canonicalPort("urn:gowm:capability:geometry:geojson-geometry:1.0", "GEOMETRY", "UNSPECIFIED");
}

function coordinateSpacePort(): WorldQueryPlanV2SchemaPort {
  return canonicalPort("urn:gowm:capability:geometry:coordinate-space:1.0", "SCALAR", "UNSPECIFIED");
}

function coordinateLayoutPort(): WorldQueryPlanV2SchemaPort {
  return canonicalPort("urn:gowm:capability:geometry:coordinate-layout:1.0", "SCALAR", "UNSPECIFIED");
}

function numberPort(unit: WorldQueryPlanV2SchemaPort["unitSemantics"]): WorldQueryPlanV2SchemaPort {
  return canonicalPort("urn:gowm:v0.2:value:number", "SCALAR", unit);
}

function integerPort(): WorldQueryPlanV2SchemaPort {
  return canonicalPort("urn:gowm:v0.2:value:integer", "SCALAR", "DISCRETE");
}

function stringPort(): WorldQueryPlanV2SchemaPort {
  return canonicalPort("urn:gowm:v0.2:value:string", "SCALAR", "UNSPECIFIED");
}

function booleanPort(): WorldQueryPlanV2SchemaPort {
  return canonicalPort("urn:gowm:v0.2:value:boolean", "SCALAR", "DIMENSIONLESS");
}

function arrayPort(
  valueKind: WorldQueryPlanV2SchemaPort["valueKind"],
  units: WorldQueryPlanV2SchemaPort["unitSemantics"]
): WorldQueryPlanV2SchemaPort {
  return canonicalPort("urn:gowm:v0.2:value:array", valueKind, units);
}

function nodeResult(result: WorldQueryResult, nodeId: string) {
  const value = result.nodes.find((entry) => entry.nodeId === nodeId);
  if (!value) throw new Error(`missing node result ${nodeId}`);
  return value;
}

function nodeEnvelope(result: WorldQueryResult, nodeId: string) {
  const envelope = nodeResult(result, nodeId).result;
  if (!envelope) throw new Error(`missing capability envelope ${nodeId}`);
  return envelope;
}
