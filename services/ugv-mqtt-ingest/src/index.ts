import { buildUgvMqttIngestApp } from "./app.js";

const runtime = await buildUgvMqttIngestApp();
const port = Number.parseInt(process.env.UGV_MQTT_INGEST_PORT ?? "3010",10);
await runtime.app.listen({ host: "0.0.0.0",port });

for (const signal of ["SIGINT","SIGTERM"] as const) {
  process.once(signal,() => void runtime.close().finally(() => process.exit(0)));
}
