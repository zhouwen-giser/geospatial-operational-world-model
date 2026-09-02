import { createCrsHttpServer } from "./server.js";

const port = integerFromEnv("PORT", 8080);
const host = process.env.HOST ?? "0.0.0.0";
const runtime = createCrsHttpServer({
  maxPoints: integerFromEnv("CRS_MAX_POINTS", 100_000),
  maxVertices: integerFromEnv("CRS_MAX_VERTICES", 100_000),
  maxRequestBytes: integerFromEnv("CRS_MAX_REQUEST_BYTES", 16 * 1024 * 1024),
  requestTimeoutMs: integerFromEnv("CRS_REQUEST_TIMEOUT_MS", 30_000)
});

runtime.server.listen(port, host, () => {
  console.info(
    JSON.stringify({
      level: "info",
      message: "crs-api listening",
      host,
      port,
      engine: runtime.adapter.engineInfo()
    })
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    runtime.server.close((error) => {
      process.exitCode = error ? 1 : 0;
    });
  });
}

function integerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export { createCrsHttpServer } from "./server.js";
