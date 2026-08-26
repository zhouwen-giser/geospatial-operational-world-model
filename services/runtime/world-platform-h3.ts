import { isAbsolute } from "node:path";
import { APPROVED_H3_TOOLKIT_BINDINGS_ARTIFACT_DIGESTS, loadVerifiedH3Bindings, LockedExternalH3ToolkitAdapter, buildH3ProviderApp, createH3InteractiveProvider, createH3AnalysisProvider, H3_INTERACTIVE_OPERATION_IDS, H3_ANALYSIS_OPERATION_IDS } from "../../packages/integrations/h3-toolkit-bridge/src/index.js";
import { validateProviderTransportToken } from "../../packages/platform/provider-sdk/src/index.js";

// Composition only: all H3 algorithms execute the separately built, locked upstream package.
const mode = process.argv[2];
if (mode !== "interactive" && mode !== "analysis") throw new Error("Explicit H3 deployment mode must be interactive or analysis");
const modulePath = process.env.H3_TOOLKIT_BINDINGS_MODULE, digest = process.env.H3_TOOLKIT_BINDINGS_MODULE_SHA256;
if (!modulePath || !isAbsolute(modulePath) || !modulePath.endsWith(".mjs") || !digest || !APPROVED_H3_TOOLKIT_BINDINGS_ARTIFACT_DIGESTS.includes(digest as `sha256:${string}`)) throw new Error("H3 artifact must match the committed reproducible-build approval");
const bindings = await loadVerifiedH3Bindings(modulePath, digest as `sha256:${string}`);
const upstream = new LockedExternalH3ToolkitAdapter(bindings, { supportedOperations: mode === "interactive" ? H3_INTERACTIVE_OPERATION_IDS : H3_ANALYSIS_OPERATION_IDS, artifactDigest: digest as `sha256:${string}` });
const bridge = mode === "interactive" ? createH3InteractiveProvider({ upstream }) : createH3AnalysisProvider({ upstream });
const app = buildH3ProviderApp(bridge, validateProviderTransportToken(process.env.PROVIDER_TRANSPORT_SHARED_TOKEN));
const port = Number(process.env.H3_PROVIDER_PORT ?? (mode === "interactive" ? "8088" : "8089"));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid H3_PROVIDER_PORT");
await app.listen({ host: process.env.H3_PROVIDER_HOST ?? "0.0.0.0", port });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close(); });
