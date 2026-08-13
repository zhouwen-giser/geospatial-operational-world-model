import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createWorldMcpServer } from "../../services/world-mcp-server/src/server.js";

let mockServer: Server;
let baseUrl: string;

beforeEach(async () => {
  mockServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    response.writeHead(request.url?.includes("missing") ? 404 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      summary: { count: 1, nearestDistanceM: 230 },
      facts: [{ object: { id: "ugv-001", type: "UGV", state: { status: "AVAILABLE" } }, distanceM: 230 }],
      request: body,
      context: { worldVersion: 42, dataFreshnessMs: 250, queryTimeMs: 3 }
    }));
  });
  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const address = mockServer.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.WORLD_API_URL = baseUrl;
  process.env.OBSERVATION_API_URL = baseUrl;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => mockServer.close((error) => error ? reject(error) : resolve()));
});

describe("C8 Agent MCP", () => {
  it("lists tools and invokes nearby without database knowledge", async () => {
    const server = createWorldMcpServer();
    const client = new Client({ name: "scenario-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "get_world_state", "find_nearby_objects", "find_objects_in_area",
      "get_area_situation", "get_h3_situation", "get_h3_hotspots",
      "get_object_track", "publish_observation"
    ]));
    const result = await client.callTool({
      name: "find_nearby_objects",
      arguments: { location: { lon: 116.4, lat: 39.9 }, objectTypes: ["UGV"], radiusM: 5_000, filter: { status: "AVAILABLE" }, limit: 5 }
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ summary: { count: 1 }, context: { worldVersion: 42 } });
    await client.close();
    await server.close();
  });
});
