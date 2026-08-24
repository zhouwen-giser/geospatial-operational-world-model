import { loadGatewayServerConfig } from "./config.js";
import { createGatewayRuntime } from "./runtime.js";

try {
  const config = await loadGatewayServerConfig();
  const runtime = await createGatewayRuntime(config);
  await runtime.app.listen({ host: config.host, port: config.port });
  process.stdout.write(JSON.stringify({
    level: "info",
    message: "World Capability Gateway listening",
    host: config.host,
    port: config.port,
    registryVersion: runtime.registry.revision,
    providerCount: config.providers.length
  }) + "\n");

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void runtime.close().then(
      () => { process.exitCode = 0; },
      () => { process.exitCode = 1; }
    );
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch {
  process.stderr.write("World Capability Gateway startup failed\n");
  process.exitCode = 1;
}
