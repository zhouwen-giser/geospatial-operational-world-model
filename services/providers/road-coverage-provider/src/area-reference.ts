import type { Pool } from "pg";
import type { DataSnapshotContext, GowmV06RoadCoverageRequest } from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, type ProviderHandlerContext } from "../../../../packages/platform/provider-sdk/src/index.js";

export async function resolveCoverageArea(
  pool: Pick<Pool, "connect">, request: GowmV06RoadCoverageRequest, context: ProviderHandlerContext
): Promise<{ request: GowmV06RoadCoverageRequest; resource?: DataSnapshotContext["resources"][number] }> {
  if ("type" in request.area) return { request };
  const key = request.area;
  if (key.namespace !== "gowm" || key.kind !== "LAYER_FEATURE") {
    throw new ProviderProtocolError("INVALID_REQUEST", "Coverage area references require a pinned LAYER_FEATURE Polygon or MultiPolygon");
  }
  const scope = context.security.dataScopeClaim, dataset = context.security.datasetScopeClaims?.[0];
  if (!scope || !dataset) throw new ProviderProtocolError("SCOPE_REQUIRED", "Coverage area requires data and dataset scopes");
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); open = true;
    await client.query("SELECT set_config('statement_timeout',$1,true)", [`${Math.max(1,Math.floor(context.deadline.remainingMs()))}ms`]);
    await client.query("SELECT gowm_network_v1.set_scope($1,$2)", [scope,dataset]);
    const result = await client.query<{geometry: GowmV06RoadCoverageRequest["area"];feature_version:string;content_hash:`sha256:${string}`}>(
      "SELECT DISTINCT geometry,feature_version,content_hash FROM gowm_network_v1.coverage_area_reference WHERE reference_key=$1 AND reference_version=$2", [key.id,key.version]);
    if (result.rows.length !== 1) throw new ProviderProtocolError("VERSION_NOT_FOUND", "Pinned coverage area is unavailable or ambiguous in the authorized scope");
    const row = result.rows[0]!;
    await client.query("COMMIT"); open = false;
    return { request: {...request, area: row.geometry}, resource: {
      referenceKey: {...key,version:row.feature_version}, authority:"gowm_catalog_v1.feature_version",pinning:"PINNED",digest:row.content_hash
    } };
  } catch (error) {
    if (open) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
