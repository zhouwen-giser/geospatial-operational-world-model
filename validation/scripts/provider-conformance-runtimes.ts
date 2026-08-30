import { Pool } from "pg";
import { createGroundingCatalogProvider } from "../../services/providers/grounding-catalog-provider/src/provider.js";
import { createSpatialProviderBridge } from "../../services/providers/spatial-provider-bridge/src/provider.js";
import { createH3AnalysisProvider, createH3InteractiveProvider, H3_OPERATION_IDS, lockedAttestation } from "../../packages/integrations/h3-toolkit-bridge/src/index.js";
import { createNetworkProvider } from "../../services/providers/network-provider/src/provider.js";
import { createRoutePlanningProvider } from "../../services/providers/route-planning-provider/src/provider.js";
import { createRoadCoverageProvider, PostgresRoadCoverageEngine } from "../../services/providers/road-coverage-provider/src/provider.js";
import { createPlatformValidationProvider, PostgresPlatformValidationAuthority } from "../../services/providers/platform-validation-provider/src/index.js";
import { createHistoricalTraceProvider } from "../../services/providers/historical-trace-provider/src/provider.js";

/** Manifest and fail-closed protocol inspection only: never connects or claims readiness. */
export function currentProviderRuntimes() {
  const pool = new Pool({ connectionString: "postgresql://unused@127.0.0.1:1/conformance_no_io" });
  const cursorSecret = "ConformanceManifestInspectionOnly_2026_NoDatabase";
  const upstream = {
    attestation: lockedAttestation("TEST_DOUBLE"), supportedOperations: H3_OPERATION_IDS,
    async execute(): Promise<never> { throw new Error("Conformance manifest inspection must not execute H3 upstream"); },
    async readiness() { return { ready: false, reasons: ["MANIFEST_INSPECTION_ONLY"], sourceGitCommit: "", toolkitVersion: "", engineVersion: "" }; }
  };
  return [
    ...(["reference", "dataset", "evidence"] as const).map((mode) => ({ slug: mode === "dataset" ? "dataset-catalog" : mode === "evidence" ? "world-evidence" : mode, sourceRoot: "services/providers/grounding-catalog-provider/src", runtime: createGroundingCatalogProvider({ mode, pool, cursorSecret }).runtime })),
    { slug: "spatial", sourceRoot: "services/providers/spatial-provider-bridge/src", runtime: createSpatialProviderBridge({ pool, cursorSecret, postgisVersion: "3.6.1" }).runtime },
    { slug: "h3", sourceRoot: "packages/integrations/h3-toolkit-bridge/src", runtime: createH3AnalysisProvider({ upstream }).runtime },
    { slug: "h3-interactive", sourceRoot: "packages/integrations/h3-toolkit-bridge/src", runtime: createH3InteractiveProvider({ upstream }).runtime },
    { slug: "network", sourceRoot: "services/providers/network-provider/src", runtime: createNetworkProvider({ pool }).runtime },
    { slug: "route", sourceRoot: "services/providers/route-planning-provider/src", runtime: createRoutePlanningProvider({ pool }).runtime },
    { slug: "road-coverage", sourceRoot: "services/providers/road-coverage-provider/src", runtime: createRoadCoverageProvider(new PostgresRoadCoverageEngine({ pool })).runtime },
    { slug: "platform-validation", sourceRoot: "services/providers/platform-validation-provider/src", runtime: createPlatformValidationProvider(new PostgresPlatformValidationAuthority(pool)).runtime },
    { slug: "historical-trace", sourceRoot: "services/providers/historical-trace-provider/src", runtime: createHistoricalTraceProvider({ pool }).runtime }
  ];
}
