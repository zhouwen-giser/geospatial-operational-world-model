import { Pool } from "pg";
import { currentProviderRuntimes } from "../validation/scripts/provider-conformance-runtimes.js";
import { createOperationalRealityProvider } from "../services/providers/operational-reality-provider/src/provider.js";
import { createGowmSituationProvider } from "../services/providers/gowm-situation-provider/src/provider.js";
import { createCrsProviderBridge } from "../services/providers/crs-provider-bridge/src/provider.js";
import { createGeometryProviderBridge } from "../services/providers/geometry-provider-bridge/src/provider.js";
import { POC_OPENAPI_SHA256 as CRS_API, POC_SOURCE_ZIP_SHA256 as CRS_ZIP } from "../services/providers/crs-provider-bridge/src/schemas.js";
import { POC_GEOS_VERSION, POC_INTEGRATION_VERSION, POC_OPENAPI_SHA256 as GEOMETRY_API, POC_SOURCE_ZIP_SHA256 as GEOMETRY_ZIP } from "../services/providers/geometry-provider-bridge/src/schemas.js";
import { sha256 } from "../packages/platform/provider-sdk/src/index.js";
import { createStasProvider } from "../services/providers/stas-provider/src/provider.js";
import { endpointConfigurationDigest } from "../services/providers/crs-provider-bridge/src/upstream-client.js";

/** Offline factory/manifest inspection. No readiness or external execution is claimed. */
export function formalProviderRuntimes() {
  const pool = new Pool({ connectionString: "postgresql://unused@127.0.0.1:1/manifest_inspection" });
  const noIO = async (): Promise<never> => { throw new Error("Manifest inspection cannot perform IO"); };
  const endpointId = "manifest-inspection", baseUrl = "http://127.0.0.1:1";
  const endpoint = { endpointId, baseUrl, approvalStatus: "APPROVED" as const, configurationDigest: endpointConfigurationDigest(endpointId, baseUrl) };
  return [
    ...currentProviderRuntimes().map((d) => d.runtime),
    createOperationalRealityProvider({ pool }).runtime,
    createGowmSituationProvider({ acceptedDataScope: "manifest-inspection", port: { getCells: noIO, candidateReferences: noIO, areaCells: noIO, ranked: noIO, worldVersion: noIO } }).runtime,
    createCrsProviderBridge({ endpoint, attestation: { sourceZipSha256: CRS_ZIP, openApiSha256: CRS_API, projVersion: "9.5.1", integration: "gdal-async", integrationVersion: "3.11.4", projDbVersion: "inspection", projDbSha256: sha256("inspection"), gridBundleVersion: "inspection", gridBundleSha256: sha256("inspection"), strictBestOperation: true, networkEnabled: false }, fetch: noIO }).runtime,
    createGeometryProviderBridge({ endpoint, attestation: { sourceZipSha256: GEOMETRY_ZIP, openApiSha256: GEOMETRY_API, engine: "GEOS-WASM-WORKER-POOL", geosVersion: POC_GEOS_VERSION, integration: "geos-wasm", integrationVersion: POC_INTEGRATION_VERSION, workerPoolEnabled: true, projectLicense: "UNSPECIFIED" }, fetch: noIO }).runtime,
    createStasProvider({ withTransaction: noIO }, { execute: noIO }).runtime
  ];
}
