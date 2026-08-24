import {
  buildH3ProviderApp,
  createH3InteractiveProvider,
  type H3ToolkitBridgeOptions
} from "../../../../packages/integrations/h3-toolkit-bridge/src/index.js";

export function createH3InteractiveProviderApp(options: H3ToolkitBridgeOptions, transportToken: string) {
  const bridge = createH3InteractiveProvider(options);
  return { bridge, app: buildH3ProviderApp(bridge, transportToken) };
}

export { createH3InteractiveProvider };
export { loadH3InteractiveServerConfig } from "./config.js";
export type { H3ToolkitBridgeOptions };
