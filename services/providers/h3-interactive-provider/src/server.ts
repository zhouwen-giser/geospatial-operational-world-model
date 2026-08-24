import { buildH3ProviderApp, createH3InteractiveProvider } from "../../../../packages/integrations/h3-toolkit-bridge/src/index.js";
import { loadH3InteractiveServerConfig } from "./config.js";

try {
  const config = await loadH3InteractiveServerConfig();
  const bridge = createH3InteractiveProvider(config.provider);
  const app = buildH3ProviderApp(bridge, config.transportToken);
  await app.listen({ host: config.host, port: config.port });
  process.stdout.write(JSON.stringify({
    level: "info",
    message: "H3 interactive provider listening",
    host: config.host,
    port: config.port,
    providerId: bridge.runtime.manifest.provider.providerId
  }) + "\n");
  const close = (): void => { void app.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch {
  process.stderr.write("H3 interactive provider startup failed\n");
  process.exitCode = 1;
}
