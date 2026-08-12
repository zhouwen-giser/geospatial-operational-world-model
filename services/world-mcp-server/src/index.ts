import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadConfig } from "../../../packages/world-model-core/src/config.js";
import { createWorldMcpServer } from "./server.js";

async function startStdio(): Promise<void> {
  const server = createWorldMcpServer();
  await server.connect(new StdioServerTransport());
}

async function startHttp(): Promise<void> {
  const port = loadConfig().mcpPort;
  const httpServer = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", service: "world-model-mcp-server", transport: "streamable-http" }));
      return;
    }
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
      return;
    }
    try {
      const body = await readJsonBody(request);
      const server = createWorldMcpServer();
      // SDK 1.x documents undefined for stateless mode; the cast works around its
      // declaration's exactOptionalPropertyTypes incompatibility.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, body);
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: error instanceof Error ? error.message : String(error) }, id: null }));
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(port, "0.0.0.0", resolve));
  process.stdout.write(`world-model-mcp-server listening on ${port}\n`);
  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

(process.argv.includes("--http") ? startHttp() : startStdio()).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
