import {
  buildH3ProviderApp,
  createH3AnalysisProvider,
  type H3ToolkitBridgeOptions
} from "../../../../packages/integrations/h3-toolkit-bridge/src/index.js";

export function createH3AnalysisProviderApp(options: H3ToolkitBridgeOptions, transportToken: string) {
  const bridge = createH3AnalysisProvider(options);
  return { bridge, app: buildH3ProviderApp(bridge, transportToken) };
}

export { createH3AnalysisProvider };
export { loadH3AnalysisServerConfig } from "./config.js";
export type { H3ToolkitBridgeOptions };
