import { buildObservationApp } from "./app.js";
import { loadConfig } from "../../../packages/world-model-core/src/config.js";

const app = buildObservationApp();
const config = loadConfig();

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen({ host: "0.0.0.0", port: config.observationApiPort }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
