import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWorldQueryReadonlyMcpServer } from "./split-servers.js";

const server = createWorldQueryReadonlyMcpServer();
await server.connect(new StdioServerTransport());

