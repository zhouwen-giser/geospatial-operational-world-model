import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createObservationCommandMcpServer } from "./split-servers.js";

const server = createObservationCommandMcpServer();
await server.connect(new StdioServerTransport());

