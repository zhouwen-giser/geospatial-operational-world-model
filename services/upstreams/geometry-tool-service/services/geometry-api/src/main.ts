import { pathToFileURL } from "node:url";
import { buildGeometryApi } from "./app.js";

export { buildGeometryApi } from "./app.js";

async function main(): Promise<void> {
  const app = await buildGeometryApi({ logger: process.env.GEOMETRY_LOGGER !== "false" });
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
