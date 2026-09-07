import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildGeometryApi } from "../../../services/upstreams/geometry-tool-service/services/geometry-api/dist/main.js";
import { GeometryCore } from "../../../services/upstreams/geometry-tool-service/packages/geometry-core/dist/index.js";
import { GeosWorkerPoolAdapter } from "../../../services/upstreams/geometry-tool-service/adapters/geos/dist/index.js";

let app;
const point = (coordinates, srid) => ({ geometry: { type: "Point", coordinates }, ...(srid === undefined ? {} : { srid }) });
const square = { geometry: { type: "Polygon", coordinates: [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]] }, srid: 3857 };
before(async () => {
  app = await buildGeometryApi({ logger: false, core: new GeometryCore({ adapter: new GeosWorkerPoolAdapter({ size: 1 }) }) });
  assert.equal((await app.inject({ method: "GET", url: "/ready" })).statusCode, 200);
});
after(async () => { await app?.close(); });

async function execute(payload, status = 200) {
  const response = await app.inject({ method: "POST", url: "/v1/geometry/execute", payload });
  assert.equal(response.statusCode, status, response.body);
  return response.json();
}

test("collect rejects different declared SRIDs, including later members", async () => {
  for (const inputs of [
    [point([120, 30], 4326), point([120, 30], 3857)],
    [point([0, 0]), point([120, 30], 4326), point([120, 30], 3857)]
  ]) {
    const body = await execute({ operation: "collect", inputs }, 422);
    assert.equal(body.error.code, "SRID_MISMATCH");
  }
});

test("collect preserves a shared declared SRID without assigning one to unknown inputs", async () => {
  const inputs = [point([1, 2], 3857), point([3, 4], 3857)];
  const same = await execute({ operation: "collect", inputs });
  assert.equal(same.summary.srid, 3857);
  assert.deepEqual(same.result.geometries, inputs.map((input) => input.geometry));
  const unknown = await execute({ operation: "collect", inputs: [point([1, 2]), point([3, 4], 3857)] });
  assert.equal(unknown.summary.srid, undefined);
});

test("binary geometry operations still reject mismatched SRIDs", async () => {
  const body = await execute({ operation: "intersection", input: point([1, 2], 4326), other: point([1, 2], 3857) }, 422);
  assert.equal(body.error.code, "SRID_MISMATCH");
});

test("orient_polygon returns the requested clockwise and counter-clockwise rings", async () => {
  for (const exteriorClockwise of [true, false]) {
    const body = await execute({ operation: "orient_polygon", input: square, parameters: { exteriorClockwise } });
    const ring = body.result.coordinates[0];
    const signedArea = ring.slice(0, -1).reduce((sum, [x, y], i) => sum + x * ring[i + 1][1] - ring[i + 1][0] * y, 0);
    assert.equal(signedArea < 0, exteriorClockwise);
    assert.equal(Math.abs(signedArea), 50);
    assert.equal(body.summary.valid, true);
  }
});

test("geometry_hash applies envelope precision exactly like request precision", async () => {
  const input = point([0.4, 0.4]);
  const options = { precision: { gridSize: 1 } };
  const envelope = await execute({ operation: "geometry_hash", input: { ...input, options } });
  const request = await execute({ operation: "geometry_hash", input, options });
  const rounded = await execute({ operation: "geometry_hash", input: point([0, 0]) });
  const floating = await execute({ operation: "geometry_hash", input });
  assert.equal(envelope.result, request.result);
  assert.equal(envelope.result, rounded.result);
  assert.notEqual(envelope.result, floating.result);
});

test("geometry_hash retains request precision precedence over envelope precision", async () => {
  const input = point([0.4, 0.4]);
  const result = await execute({ operation: "geometry_hash", input: { ...input, options: { precision: { gridSize: 1 } } }, options: { precision: { gridSize: 0.5 } } });
  const expected = await execute({ operation: "geometry_hash", input: point([0.5, 0.5]) });
  assert.equal(result.result, expected.result);
});
