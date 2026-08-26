import type { DataSnapshotContext, PlatformCommonDefinitionsReferenceKey as ReferenceKey } from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import { catalogScopeDigest, decodeCatalogCursor, encodeCatalogCursor } from "./cursor.js";
import { decodeEvidenceCursor, encodeEvidenceCursor } from "./evidence-cursor.js";
import type { GroundingCatalogOperationId } from "./schemas.js";
import type {
  CatalogSqlClient,
  GroundingCatalogExecutionResult,
  GroundingCatalogRepositoryOptions
} from "./types.js";

type Row = Record<string, unknown>;

export class GroundingCatalogRepository {
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly maximumRows: number;
  private readonly maximumCandidates: number;

  constructor(private readonly options: GroundingCatalogRepositoryOptions) {
    if (Buffer.byteLength(options.cursorSecret, "utf8") < 32) throw new Error("catalog cursor secret must contain at least 32 bytes");
    this.statementTimeoutMs = positive(options.statementTimeoutMs ?? 5_000, "statementTimeoutMs");
    this.lockTimeoutMs = positive(options.lockTimeoutMs ?? 1_000, "lockTimeoutMs");
    this.maximumRows = bounded(options.maximumRows ?? 1_000, 1_000, "maximumRows");
    this.maximumCandidates = bounded(options.maximumCandidates ?? 5_000, 5_000, "maximumCandidates");
  }

  async execute(
    operationId: GroundingCatalogOperationId,
    input: unknown,
    security: { dataScopeKey?: string; datasetScopeKey?: string },
    deadlineRemainingMs: number
  ): Promise<GroundingCatalogExecutionResult> {
    const dataScopeKey = security.dataScopeKey?.trim();
    if (!dataScopeKey) throw new ProviderProtocolError("SCOPE_DENIED", "data scope is required");
    const isDataset = operationId.startsWith("dataset.") || operationId.startsWith("layer.") || operationId.startsWith("feature.") || operationId.startsWith("catalog.");
    const isDataProduct = operationId.startsWith("catalog.");
    const isEvidence = operationId.startsWith("world.") || operationId.startsWith("result.") || operationId.startsWith("reference-set.");
    const datasetScopeKey = security.datasetScopeKey?.trim();
    if (isDataset && !datasetScopeKey) throw new ProviderProtocolError("SCOPE_DENIED", "dataset scope is required");
    const client = await this.options.pool.connect().catch((cause: unknown) => {
      throw new ProviderProtocolError("PROVIDER_NOT_READY", "catalog read pool is unavailable", { retryable: true, cause });
    });
    let open = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      open = true;
      const statementTimeout = Math.max(1, Math.min(this.statementTimeoutMs, Math.floor(deadlineRemainingMs)));
      await client.query("SELECT set_config('statement_timeout', $1::text, true)", [`${statementTimeout}ms`]);
      await client.query("SELECT set_config('lock_timeout', $1::text, true)", [`${Math.min(this.lockTimeoutMs, statementTimeout)}ms`]);
      if (isDataset) {
        await client.query("SELECT gowm_catalog_v1.set_scope($1::text,$2::text)", [dataScopeKey, datasetScopeKey]);
      } else if (isEvidence) {
        await client.query("SELECT gowm_evidence_v1.set_data_scope($1::text)", [dataScopeKey]);
        await client.query("SELECT set_config('gowm.dataset_scope_key',$1::text,true)", [datasetScopeKey ?? ""]);
      } else {
        await client.query("SELECT gowm_reference_v1.set_data_scope($1::text)", [dataScopeKey]);
      }
      const snapshot = await this.snapshot(client, dataScopeKey, isDataset ? datasetScopeKey : undefined, isDataset ? "dataset" : isEvidence ? "evidence" : "reference");
      const result = isDataProduct
        ? await this.dataProductOperation(client, operationId, asRecord(input), snapshot)
        : isDataset ? await this.datasetOperation(client, operationId, asRecord(input), snapshot)
        : isEvidence ? await this.evidenceOperation(client, operationId, asRecord(input), snapshot)
        : await this.referenceOperation(client, operationId, asRecord(input), snapshot);
      await client.query("COMMIT");
      open = false;
      return result;
    } catch (error) {
      if (open) await client.query("ROLLBACK").catch(() => undefined);
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async readiness(mode: "reference" | "dataset" | "evidence"): Promise<{ ready: boolean; reasons: string[] }> {
    let client: CatalogSqlClient | undefined;
    try {
      client = await this.options.pool.connect();
      const schema = mode === "reference" ? "gowm_reference_v1" : mode === "dataset" ? "gowm_catalog_v1" : "gowm_evidence_v1";
      const view = mode === "reference" ? "current_descriptor" : mode === "dataset" ? "dataset" : "current_state";
      await client.query(`SELECT * FROM ${schema}.${view} LIMIT 0`);
      await client.query(`SELECT * FROM ${schema}.scope_resource LIMIT 0`);
      return { ready: true, reasons: [] };
    } catch {
      return { ready: false, reasons: [`${mode} catalog read contract is unavailable`] };
    } finally {
      client?.release();
    }
  }

  private async snapshot(
    client: CatalogSqlClient,
    dataScopeKey: string,
    datasetScopeKey: string | undefined,
    mode: "reference" | "dataset" | "evidence"
  ): Promise<{ context: DataSnapshotContext; version: string; worldVersion: number; scopeDigest: `sha256:${string}` }> {
    const schema = mode === "dataset" ? "gowm_catalog_v1" : mode === "evidence" ? "gowm_evidence_v1" : "gowm_reference_v1";
    const versionResult = mode === "dataset"
      ? await client.query("SELECT reference_key,version,content_hash FROM gowm_catalog_v1.dataset ORDER BY reference_key")
      : mode === "evidence"
        ? await client.query(`SELECT reference_key,version_marker FROM (
            SELECT reference_key,world_version::text AS version_marker FROM gowm_evidence_v1.current_state
            UNION ALL SELECT 'observation:' || reference_key,
              count(*)::text || ':' || max(created_at)::text || ':' || max(observation_id)
              FROM gowm_evidence_v1.observation GROUP BY reference_key
            UNION ALL SELECT 'event:' || reference_key,
              count(*)::text || ':' || max(created_at)::text || ':' || max(event_id)
              FROM gowm_evidence_v1.world_event GROUP BY reference_key
            UNION ALL SELECT reference_key,result_hash FROM gowm_result_v1.query_result
            UNION ALL SELECT reference_key,data_snapshot_hash || ':' || compute_snapshot_hash FROM gowm_result_v1.derived_reference
            UNION ALL SELECT reference_key,member_count::text FROM gowm_result_v1.reference_set
          ) snapshot_rows ORDER BY reference_key,version_marker`)
      : await client.query("SELECT COALESCE(max(descriptor_version),0)::text AS version, COALESCE(max(world_version),0) AS world_version FROM gowm_reference_v1.current_descriptor");
    const resourceResult = await client.query(`SELECT reference_key_value FROM ${schema}.scope_resource ORDER BY reference_key LIMIT 1`);
    const referenceKey = referenceKeyValue(resourceResult.rows[0]?.reference_key_value);
    const version = mode === "reference" ? requiredString(versionResult.rows[0]?.version, "snapshot.version") : sha256(versionResult.rows);
    const worldVersion = mode === "reference"
      ? safeInteger(versionResult.rows[0]?.world_version, "snapshot.world_version")
      : mode === "evidence"
        ? safeInteger((await client.query(`SELECT GREATEST(
            COALESCE((SELECT max(world_version) FROM gowm_evidence_v1.current_state),0),
            COALESCE((SELECT max(world_version) FROM gowm_evidence_v1.world_event),0)
          ) AS world_version`)).rows[0]?.world_version, "snapshot.world_version")
        : 0;
    const scopeDigest = catalogScopeDigest(dataScopeKey, datasetScopeKey);
    const capturedAt = (this.options.now ?? (() => new Date()))().toISOString();
    return {
      version,
      worldVersion,
      scopeDigest,
      context: {
        consistency: "CONSISTENT_AT_START",
        capturedAt,
        scopeDigest,
        resources: [{
          referenceKey,
          authority: "GOWM Foundation",
          pinning: "AT_LEAST",
          digest: sha256({ contract: schema, version, referenceKey })
        }]
      }
    };
  }

  private async referenceOperation(
    client: CatalogSqlClient,
    operationId: GroundingCatalogOperationId,
    input: Row,
    snapshot: { context: DataSnapshotContext; version: string; worldVersion: number; scopeDigest: `sha256:${string}` }
  ): Promise<GroundingCatalogExecutionResult> {
    if (operationId === "reference.get") {
      const descriptor = await this.descriptor(client, referenceId(input.referenceKey));
      if (!descriptor) throw scopeOpaqueNotFound("reference");
      return result(descriptor, snapshot.context, 1, 1);
    }
    if (operationId === "reference.resolve" || operationId === "reference.search") {
      const mentions = Array.isArray(input.mentions) ? input.mentions.map(asRecord) : [];
      const limit = safeInteger(input.limitPerMention, "limitPerMention");
      const resolutions = [];
      let candidateCount = 0;
      for (const mention of mentions) {
        const query = await client.query(
          "SELECT * FROM gowm_reference_v1.resolve($1::text,$2::text[],$3::integer,0.3,$4::integer)",
          [requiredString(mention.surfaceText, "surfaceText"), stringArrayOrNull(mention.expectedKinds), limit, this.maximumCandidates]
        );
        candidateCount += query.rows.length;
        if (candidateCount > this.maximumCandidates) throw budgetExceeded(this.maximumCandidates);
        const candidates = [];
        for (const row of query.rows) {
          const descriptor = await this.descriptor(client, requiredString(row.reference_key, "reference_key"));
          if (descriptor) candidates.push({
            candidate: descriptor,
            matchedBy: matchedBy(row.matched_by),
            matchScore: finite(row.match_score, "match_score")
          });
        }
        resolutions.push({
          mentionId: requiredString(mention.mentionId, "mentionId"),
          status: resolutionStatus(candidates),
          candidates
        });
      }
      return result({ schemaVersion: "1.0", resolutions, worldVersion: snapshot.worldVersion, resolverVersion: "gowm-reference-v1/1.0" }, snapshot.context, candidateCount, candidateCount);
    }
    const references = Array.isArray(input.references) ? input.references.map(asRecord) : [];
    if (operationId === "reference.batch-get") {
      const items = [];
      for (const requested of references) {
        const descriptor = await this.descriptor(client, referenceId(requested.referenceKey));
        if (descriptor) items.push(descriptor);
      }
      return result({ schemaVersion: "1.0", items, truncated: false }, snapshot.context, items.length, references.length);
    }
    throw new ProviderProtocolError("OPERATION_NOT_FOUND", `unsupported reference operation ${operationId}`);
  }

  private async descriptor(client: CatalogSqlClient, id: string): Promise<Row | undefined> {
    const query = await client.query(
      `SELECT descriptor.*,
              COALESCE((SELECT jsonb_agg(name_text ORDER BY name_text)
                        FROM gowm_reference_v1.name_entry name
                        WHERE name.reference_key=descriptor.reference_key AND name.name_kind='ALIAS'), '[]'::jsonb) AS aliases
       FROM gowm_reference_v1.current_descriptor descriptor
       WHERE descriptor.reference_key=$1::text`, [id]
    );
    return query.rows[0] ? mapReferenceDescriptor(query.rows[0]) : undefined;
  }

  private async datasetOperation(
    client: CatalogSqlClient,
    operationId: GroundingCatalogOperationId,
    input: Row,
    snapshot: { context: DataSnapshotContext; version: string; worldVersion: number; scopeDigest: `sha256:${string}` }
  ): Promise<GroundingCatalogExecutionResult> {
    if (operationId === "dataset.get") {
      const item = await this.dataset(client, referenceId(input.referenceKey));
      if (!item) throw scopeOpaqueNotFound("dataset");
      return result(item, snapshot.context, 1, 1);
    }
    if (operationId === "layer.get") {
      const query = await client.query(
        `SELECT layer.*,dataset.reference_key_value AS dataset_reference_key_value
         FROM gowm_catalog_v1.layer layer
         JOIN gowm_catalog_v1.dataset dataset ON dataset.reference_key=layer.dataset_reference_key
         WHERE layer.reference_key=$1::text`, [referenceId(input.referenceKey)]
      );
      const item = query.rows[0] ? mapLayer(query.rows[0]) : undefined;
      if (!item) throw scopeOpaqueNotFound("layer");
      return result(item, snapshot.context, 1, 1);
    }
    if (operationId === "feature.get") {
      const query = await client.query(
        `SELECT feature.*,layer.reference_key_value AS layer_reference_key_value
         FROM gowm_catalog_v1.feature feature
         JOIN gowm_catalog_v1.layer layer ON layer.reference_key=feature.layer_reference_key
         WHERE feature.reference_key=$1::text`, [referenceId(input.referenceKey)]
      );
      const item = query.rows[0] ? mapFeature(query.rows[0]) : undefined;
      if (!item) throw scopeOpaqueNotFound("feature");
      return result(item, snapshot.context, 1, 1);
    }
    const limit = Math.min(optionalInteger(input.limit, 100), this.maximumRows);
    const cursor = decodeCatalogCursor(typeof input.cursor === "string" ? input.cursor : undefined, {
      operationId,
      scopeDigest: snapshot.scopeDigest,
      snapshotVersion: snapshot.version
    }, this.options.cursorSecret);
    const after = cursor?.after ?? "";
    let sql: string;
    let values: unknown[];
    if (operationId === "dataset.list") {
      sql = `SELECT * FROM gowm_catalog_v1.dataset
             WHERE reference_key > $1::text
               AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%')
               AND ($3::text[] IS NULL OR dataset_kind=ANY($3))
             ORDER BY reference_key LIMIT $4::integer`;
      values = [after, optionalString(input.query), stringArrayOrNull(input.types), limit + 1];
    } else if (operationId === "layer.list") {
      sql = `SELECT layer.*,dataset.reference_key_value AS dataset_reference_key_value
             FROM gowm_catalog_v1.layer layer
             JOIN gowm_catalog_v1.dataset dataset ON dataset.reference_key=layer.dataset_reference_key
             WHERE layer.reference_key > $1::text
               AND ($2::text IS NULL OR layer.name ILIKE '%' || $2 || '%')
               AND ($3::text[] IS NULL OR layer.layer_type=ANY($3))
             ORDER BY layer.reference_key LIMIT $4::integer`;
      values = [after, optionalString(input.query), stringArrayOrNull(input.types), limit + 1];
    } else if (operationId === "layer.find-features") {
      sql = `SELECT feature.*,layer.reference_key_value AS layer_reference_key_value
             FROM gowm_catalog_v1.feature feature
             JOIN gowm_catalog_v1.layer layer ON layer.reference_key=feature.layer_reference_key
             WHERE feature.reference_key > $1::text
               AND ($2::text IS NULL OR feature.layer_reference_key=$2::text)
               AND ($3::text IS NULL OR feature.display_name ILIKE '%' || $3 || '%' OR feature.feature_key ILIKE '%' || $3 || '%')
               AND ($4::text[] IS NULL OR feature.feature_type=ANY($4))
             ORDER BY feature.reference_key LIMIT $5::integer`;
      values = [after, input.referenceKey === undefined ? null : referenceId(input.referenceKey), optionalString(input.query), stringArrayOrNull(input.types), limit + 1];
    } else {
      throw new ProviderProtocolError("OPERATION_NOT_FOUND", `unsupported dataset operation ${operationId}`);
    }
    const query = await client.query(sql, values);
    if (query.rows.length > this.maximumCandidates) throw budgetExceeded(this.maximumCandidates);
    const truncated = query.rows.length > limit;
    const visible = query.rows.slice(0, limit);
    const items = operationId === "dataset.list"
      ? await Promise.all(visible.map((row) => this.dataset(client, requiredString(row.reference_key, "reference_key"))))
      : operationId === "layer.list" ? visible.map(mapLayer) : visible.map(mapFeature);
    const afterId = visible.at(-1)?.reference_key;
    const nextCursor = truncated && typeof afterId === "string" ? encodeCatalogCursor({
      v: 1, operationId, scopeDigest: snapshot.scopeDigest, snapshotVersion: snapshot.version, after: afterId
    }, this.options.cursorSecret) : undefined;
    return result({ schemaVersion: "1.0", items: items.filter(Boolean), truncated, ...(nextCursor ? { nextCursor } : {}) }, snapshot.context, visible.length, query.rows.length);
  }

  private async dataProductOperation(
    client: CatalogSqlClient,
    operationId: GroundingCatalogOperationId,
    input: Row,
    snapshot: { context: DataSnapshotContext; version: string; worldVersion: number; scopeDigest: `sha256:${string}` }
  ): Promise<GroundingCatalogExecutionResult> {
    if (operationId === "catalog.search") {
      const limit = Math.min(optionalInteger(input.limit, 100), 100, this.maximumRows);
      const cursor = decodeCatalogCursor(typeof input.cursor === "string" ? input.cursor : undefined, {
        operationId, scopeDigest: snapshot.scopeDigest, snapshotVersion: snapshot.version
      }, this.options.cursorSecret);
      const after = cursor?.after ?? "";
      const dataKinds = stringArrayOrNull(input.dataKinds);
      const crs = stringArrayOrNull(input.crs);
      const time = isRecord(input.timeFilter) ? input.timeFilter : {};
      const spatial = isRecord(input.spatialFilter) ? input.spatialFilter : null;
      const query = await client.query(
        `SELECT dataset.*,gowm_catalog_v1.dataset_spatial_extent(dataset.reference_key) AS spatial_extent
         FROM gowm_catalog_v1.dataset dataset
         WHERE dataset.reference_key>$1::text
           AND ($2::text[] IS NULL OR upper(dataset.dataset_kind)=ANY($2))
           AND ($3::text[] IS NULL OR dataset.crs=ANY($3))
           AND ($4::timestamptz IS NULL OR dataset.valid_to IS NULL OR dataset.valid_to >= $4::timestamptz)
           AND ($5::timestamptz IS NULL OR dataset.valid_from IS NULL OR dataset.valid_from <= $5::timestamptz)
           AND ($6::jsonb IS NULL OR gowm_catalog_v1.dataset_intersects(dataset.reference_key,$6::jsonb))
         ORDER BY dataset.reference_key LIMIT $7::integer`,
        [after, dataKinds, crs, finiteDate(time.from), finiteDate(time.to), spatial === null ? null : JSON.stringify(spatial), this.maximumCandidates]
      );
      const capabilityBindings = await activeCapabilityBindings(client);
      const requirements = new Set(Array.isArray(input.requiredCapabilities) ? input.requiredCapabilities.filter((item): item is string => typeof item === "string") : []);
      const minimum = typeof input.minimumValidationStatus === "string" ? input.minimumValidationStatus : undefined;
      const filtered = query.rows.map((row) => dataProduct(row, capabilityBindings)).filter((item) => requirements.size === 0 || [...requirements].every((capability) => (item.supportedCapabilities as string[]).includes(capability)))
        .filter((item) => minimum === undefined || qualityRank(requiredString((item.quality as Row).validationStatus, "validationStatus")) >= qualityRank(minimum));
      const visible = filtered.slice(0, limit);
      const truncated = filtered.length > limit || query.rows.length === this.maximumCandidates;
      const afterId = filtered.length > limit ? (visible.at(-1)?.referenceKey as Row | undefined)?.id : query.rows.at(-1)?.reference_key;
      const nextCursor = truncated && typeof afterId === "string" ? encodeCatalogCursor({
        v: 1, operationId, scopeDigest: snapshot.scopeDigest, snapshotVersion: snapshot.version, after: afterId
      }, this.options.cursorSecret) : undefined;
      return result({ schemaVersion: "1.0", items: visible, truncated, ...(nextCursor ? { nextCursor } : {}) }, snapshot.context, visible.length, query.rows.length);
    }

    const id = referenceId(input.referenceKey);
    const current = await client.query(
      `SELECT dataset.*,gowm_catalog_v1.dataset_spatial_extent(dataset.reference_key) AS spatial_extent
       FROM gowm_catalog_v1.dataset dataset WHERE dataset.reference_key=$1::text`, [id]
    );
    const row = current.rows[0];
    if (!row) throw scopeOpaqueNotFound("data product");
    const descriptor = dataProduct(row, await activeCapabilityBindings(client));
    if (operationId === "catalog.get") return result(descriptor, snapshot.context, 1, 1);
    let value: unknown;
    if (operationId === "catalog.list-versions") {
      value = (await client.query("SELECT version,schema_version,content_hash,published_at,retired_at FROM gowm_catalog_v1.dataset_version WHERE reference_key=$1 ORDER BY published_at DESC,version DESC LIMIT 100", [id])).rows.map((version) => ({
        version: requiredString(version.version, "version"),
        schema_version: requiredString(version.schema_version, "schema_version"),
        content_hash: requiredString(version.content_hash, "content_hash"),
        published_at: date(version.published_at, "published_at"),
        retired_at: finiteDate(version.retired_at) ?? null
      }));
    } else if (operationId === "catalog.describe-schema") value = { schemaRef: descriptor.schemaRef, schemaHash: descriptor.schemaHash };
    else if (operationId === "catalog.get-lineage") value = descriptor.lineage;
    else if (operationId === "catalog.get-quality") value = descriptor.quality;
    else if (operationId === "catalog.get-capabilities") value = descriptor.supportedCapabilities;
    else throw new ProviderProtocolError("OPERATION_NOT_FOUND", `unsupported data product operation ${operationId}`);
    return result({ schemaVersion: "1.0", operationId, referenceKey: descriptor.referenceKey, value }, snapshot.context, 1, 1);
  }

  private async evidenceOperation(
    client: CatalogSqlClient,
    operationId: GroundingCatalogOperationId,
    input: Row,
    snapshot: { context: DataSnapshotContext; version: string; worldVersion: number; scopeDigest: `sha256:${string}` }
  ): Promise<GroundingCatalogExecutionResult> {
    if (operationId.startsWith("world.")) {
      return this.worldEvidenceOperation(client, operationId, input, snapshot);
    }
    if (operationId === "result.get") {
      const query = await client.query("SELECT * FROM gowm_result_v1.query_result WHERE reference_key=$1::text", [referenceId(input.referenceKey)]);
      const item = query.rows[0] ? mapQueryResultReference(query.rows[0]) : undefined;
      if (!item) throw scopeOpaqueNotFound("result reference");
      return result(item, snapshot.context, 1, 1);
    }
    if (operationId === "reference-set.get-members") {
      const setKey = referenceId(input.referenceKey);
      const setQuery = await client.query("SELECT * FROM gowm_result_v1.reference_set WHERE reference_key=$1::text", [setKey]);
      const setRow = setQuery.rows[0];
      if (!setRow) throw scopeOpaqueNotFound("reference set");
      const validUntil = date(setRow.valid_until, "valid_until");
      if (new Date(validUntil).getTime() <= (this.options.now?.() ?? new Date()).getTime()) {
        throw new ProviderProtocolError("INVALID_REQUEST", "reference set is expired and requires validation");
      }
      const limit = Math.min(optionalInteger(input.limit, 100), this.maximumRows);
      const cursor = decodeCatalogCursor(typeof input.cursor === "string" ? input.cursor : undefined, {
        operationId,
        scopeDigest: snapshot.scopeDigest,
        snapshotVersion: snapshot.version
      }, this.options.cursorSecret);
      let afterOrdinal = -1;
      if (cursor) {
        const located = await client.query("SELECT member_ordinal FROM gowm_result_v1.reference_set_member WHERE set_reference_key=$1::text AND reference_key=$2::text", [setKey, cursor.after]);
        if (!located.rows[0]) throw new ProviderProtocolError("INVALID_REQUEST", "cursor member is unavailable in this reference set");
        afterOrdinal = safeInteger(located.rows[0].member_ordinal, "member_ordinal");
      }
      const membersQuery = await client.query(
        `SELECT * FROM gowm_result_v1.reference_set_member
         WHERE set_reference_key=$1::text AND member_ordinal>$2::integer
         ORDER BY member_ordinal LIMIT $3::integer`, [setKey, afterOrdinal, limit + 1]
      );
      const truncated = membersQuery.rows.length > limit;
      const visible = membersQuery.rows.slice(0, limit);
      const members = visible.map((row) => referenceKeyValue(row.reference_key_value));
      const last = members.at(-1);
      const nextCursor = truncated && last ? encodeCatalogCursor({
        v: 1, operationId, scopeDigest: snapshot.scopeDigest, snapshotVersion: snapshot.version, after: last.id
      }, this.options.cursorSecret) : undefined;
      return result({
        referenceKey: referenceKeyValue(setRow.reference_key_value),
        semanticType: requiredString(setRow.semantic_type, "semantic_type"),
        memberCount: safeInteger(setRow.member_count, "member_count"),
        members,
        membersTruncated: truncated,
        ...(nextCursor ? { nextCursor } : {}),
        sourceQueryId: requiredString(setRow.source_query_id, "source_query_id"),
        validUntil
      }, snapshot.context, members.length, membersQuery.rows.length);
    }
    throw new ProviderProtocolError("OPERATION_NOT_FOUND", `unsupported evidence operation ${operationId}`);
  }

  private async worldEvidenceOperation(
    client: CatalogSqlClient,
    operationId: GroundingCatalogOperationId,
    input: Row,
    snapshot: { context: DataSnapshotContext; version: string; worldVersion: number; scopeDigest: `sha256:${string}` }
  ): Promise<GroundingCatalogExecutionResult> {
    const inputKey = referenceKeyValue(input.referenceKey);
    if (operationId === "world.get-current-state") {
      const query = await client.query("SELECT * FROM gowm_evidence_v1.current_state WHERE reference_key=$1::text", [inputKey.id]);
      const row = query.rows[0];
      if (!row) return worldNoData(inputKey, snapshot, "CURRENT_STATE_UNAVAILABLE");
      const worldVersion = safeInteger(row.world_version, "world_version");
      const evidence = typeof row.source_observation_id === "string" ? [{
        evidenceId: row.source_observation_id,
        authority: "GOWM Foundation",
        evidenceType: "OBSERVATION",
        worldVersion,
        ...(finiteDate(row.observed_at) ? { observedAt: finiteDate(row.observed_at) } : {})
      }] : [];
      return result({
        schemaVersion: "1.0",
        referenceKey: referenceKeyValue(row.reference_key_value),
        worldVersion,
        facts: [compact({
          factKind: "CURRENT_PROJECTION",
          fields: isRecord(row.state) ? row.state : {},
          objectType: requiredString(row.object_type, "object_type"),
          ...(optionalString(row.subtype) ? { subtype: optionalString(row.subtype) } : {}),
          properties: isRecord(row.properties) ? row.properties : {},
          confidence: finite(row.confidence, "confidence"),
          freshnessMs: row.freshness_ms === null ? null : safeInteger(row.freshness_ms, "freshness_ms"),
          observedAt: finiteDate(row.observed_at),
          receivedAt: finiteDate(row.received_at),
          source: optionalString(row.source),
          sourceObservationId: optionalString(row.source_observation_id),
          uncertainty: isRecord(row.uncertainty_summary) ? row.uncertainty_summary : null
        })],
        evidence,
        unknowns: []
      }, snapshot.context, 1, 1);
    }
    if (operationId === "world.get-geometry") {
      const query = await client.query("SELECT * FROM gowm_evidence_v1.current_geometry WHERE reference_key=$1::text", [inputKey.id]);
      const row = query.rows[0];
      if (!row) return worldNoData(inputKey, snapshot, "GEOMETRY_UNAVAILABLE");
      return result({
        schemaVersion: "1.0",
        referenceKey: referenceKeyValue(row.reference_key_value),
        worldVersion: safeInteger(row.world_version, "world_version"),
        facts: [compact({ factKind: "CURRENT_GEOMETRY", geometry: row.geometry, geometryType: row.geometry_type, bbox: row.bbox, crs: row.crs, version: String(row.world_version), observedAt: finiteDate(row.observed_at) })],
        evidence: [],
        unknowns: []
      }, snapshot.context, 1, 1);
    }
    if (operationId === "world.get-provenance") {
      const query = await client.query("SELECT * FROM gowm_evidence_v1.provenance WHERE reference_key=$1::text", [inputKey.id]);
      const row = query.rows[0];
      if (!row) return worldNoData(inputKey, snapshot, "PROVENANCE_UNAVAILABLE");
      const worldVersion = safeInteger(row.world_version, "world_version");
      const evidence = typeof row.source_observation_id === "string" ? [{
        evidenceId: row.source_observation_id, authority: "GOWM Foundation", evidenceType: "OBSERVATION", worldVersion,
        ...(finiteDate(row.observed_at) ? { observedAt: finiteDate(row.observed_at) } : {})
      }] : [];
      return result({
        schemaVersion: "1.0", referenceKey: referenceKeyValue(row.reference_key_value), worldVersion,
        facts: [compact({
          factKind: "PROVENANCE",
          source: optionalString(row.source), sourceObservationId: optionalString(row.source_observation_id),
          evidenceKind: optionalString(row.evidence_kind), projectionPolicyVersion: optionalString(row.projection_policy_version),
          timeSolutionId: optionalString(row.time_solution_id), positionMeasurementId: optionalString(row.position_measurement_id),
          uncertainty: isRecord(row.uncertainty_summary) ? row.uncertainty_summary : null,
          confidence: finite(row.confidence, "confidence"), observedAt: finiteDate(row.observed_at), receivedAt: finiteDate(row.received_at)
        })],
        evidence, unknowns: []
      }, snapshot.context, 1, 1);
    }
    return this.worldTimeline(client, operationId, inputKey, input, snapshot);
  }

  private async worldTimeline(
    client: CatalogSqlClient,
    operationId: GroundingCatalogOperationId,
    inputKey: ReferenceKey,
    input: Row,
    snapshot: { context: DataSnapshotContext; version: string; worldVersion: number; scopeDigest: `sha256:${string}` }
  ): Promise<GroundingCatalogExecutionResult> {
    const limit = Math.min(optionalInteger(input.limit, 100), this.maximumRows);
    const cursor = decodeEvidenceCursor(typeof input.cursor === "string" ? input.cursor : undefined, {
      operationId, scopeDigest: snapshot.scopeDigest, snapshotVersion: snapshot.version
    }, this.options.cursorSecret);
    const eventTimeline = operationId === "world.get-event-timeline";
    const query = eventTimeline
      ? await client.query(
          `SELECT * FROM gowm_evidence_v1.world_event
           WHERE reference_key=$1::text
             AND (event_time,world_version,event_id) > ($2::timestamptz,$3::bigint,$4::text)
           ORDER BY event_time,world_version,event_id LIMIT $5::integer`,
          [inputKey.id, cursor?.time ?? "-infinity", cursor?.tie ?? "-1", cursor?.id ?? "", limit + 1]
        )
      : await client.query(
          `SELECT * FROM gowm_evidence_v1.observation
           WHERE reference_key=$1::text
             AND (observed_at,received_at,observation_id) > ($2::timestamptz,$3::timestamptz,$4::text)
           ORDER BY observed_at,received_at,observation_id LIMIT $5::integer`,
          [inputKey.id, cursor?.time ?? "-infinity", cursor?.tie ?? "-infinity", cursor?.id ?? "", limit + 1]
        );
    const truncated = query.rows.length > limit;
    const visible = query.rows.slice(0, limit);
    const items = visible.map((row) => eventTimeline ? mapWorldEvent(row) : mapObservation(row, operationId === "world.get-state-history"));
    const last = visible.at(-1);
    const nextCursor = truncated && last ? encodeEvidenceCursor({
      v: 1,
      operationId,
      scopeDigest: snapshot.scopeDigest,
      snapshotVersion: snapshot.version,
      time: date(eventTimeline ? last.event_time : last.observed_at, "cursor.time"),
      tie: eventTimeline ? String(last.world_version) : date(last.received_at, "cursor.tie"),
      id: requiredString(eventTimeline ? last.event_id : last.observation_id, "cursor.id")
    }, this.options.cursorSecret) : undefined;
    const output = { schemaVersion: "1.0", items, truncated, ...(nextCursor ? { nextCursor } : {}) };
    return { ...result(output, snapshot.context, items.length, query.rows.length), status: items.length === 0 ? "NO_DATA" : "COMPLETED" };
  }

  private async dataset(client: CatalogSqlClient, id: string): Promise<Row | undefined> {
    const current = await client.query("SELECT * FROM gowm_catalog_v1.dataset WHERE reference_key=$1::text", [id]);
    if (!current.rows[0]) return undefined;
    const versions = await client.query(
      "SELECT * FROM gowm_catalog_v1.dataset_version WHERE reference_key=$1::text ORDER BY published_at DESC, version DESC LIMIT 100", [id]
    );
    return mapDataset(current.rows[0], versions.rows);
  }
}

function result(output: unknown | undefined, dataSnapshot: DataSnapshotContext, rows: number, candidates: number): GroundingCatalogExecutionResult {
  return {
    ...(output === undefined ? {} : { output }),
    dataSnapshot,
    rows,
    candidates,
    warnings: ["grounding.scopeAppliedBeforeQuery=true", "grounding.transaction=REPEATABLE_READ_READ_ONLY", "grounding.snapshot=CONSISTENT_AT_START"]
  };
}

function mapReferenceDescriptor(row: Row): Row {
  const version: Row = { referenceVersion: String(row.descriptor_version) };
  if (typeof row.object_version === "string") version.objectVersion = row.object_version;
  if (row.world_version !== null && row.world_version !== undefined) version.worldVersion = safeInteger(row.world_version, "world_version");
  const value: Row = {
    referenceKey: { namespace: "gowm", kind: requiredString(row.entity_kind, "entity_kind"), id: requiredString(row.reference_key, "reference_key"), version: String(row.descriptor_version) },
    referenceType: requiredString(row.reference_type, "reference_type"),
    displayName: requiredString(row.display_name, "display_name"),
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    version,
    revalidationRequired: Boolean(row.revalidation_required),
    provenance: Array.isArray(row.provenance) ? row.provenance : []
  };
  const quality: Row = {};
  if (row.state_confidence !== null && row.state_confidence !== undefined) quality.stateConfidence = finite(row.state_confidence, "state_confidence");
  if (row.freshness_ms !== null && row.freshness_ms !== undefined) quality.freshnessMs = safeInteger(row.freshness_ms, "freshness_ms");
  if (typeof row.stale === "boolean") quality.stale = row.stale;
  if (Object.keys(quality).length) value.stateQuality = quality;
  if (isRecord(row.geometry_summary)) value.geometrySummary = row.geometry_summary;
  const validUntil = finiteDate(row.valid_to);
  if (validUntil) value.validUntil = validUntil;
  return value;
}

function mapDataset(current: Row, versions: Row[]): Row {
  return {
    referenceKey: referenceKeyValue(current.reference_key_value),
    datasetKind: requiredString(current.dataset_kind, "dataset_kind"),
    name: requiredString(current.name, "name"),
    currentVersion: requiredString(current.version, "version"),
    versions: versions.map((version) => compact({
      version: requiredString(version.version, "version"),
      schemaVersion: requiredString(version.schema_version, "schema_version"),
      contentHash: requiredString(version.content_hash, "content_hash"),
      crs: optionalString(version.crs),
      source: optionalString(version.source_ref),
      sourceVersion: optionalString(version.source_version),
      publishedAt: date(version.published_at, "published_at"),
      retiredAt: finiteDate(version.retired_at)
    }))
  };
}

const DATA_KINDS = new Set(["VECTOR", "RASTER", "ELEVATION", "NETWORK", "TRAJECTORY", "OBSERVATION", "EVENT", "POINT_CLOUD", "TILESET", "CURRENT_PROJECTION"]);

type CapabilityBinding = { operationId: string; dataBinding: string };

async function activeCapabilityBindings(client: CatalogSqlClient): Promise<CapabilityBinding[]> {
  const query = await client.query("SELECT operation_id,data_binding FROM gowm_catalog_v1.active_capability ORDER BY operation_id");
  return query.rows.map((row) => ({
    operationId: requiredString(row.operation_id, "operation_id"),
    dataBinding: requiredString(row.data_binding, "data_binding")
  }));
}

function dataProduct(row: Row, capabilityBindings: CapabilityBinding[]): Row {
  const rawKind = requiredString(row.dataset_kind, "dataset_kind").toUpperCase().replaceAll("-", "_");
  const dataKind = DATA_KINDS.has(rawKind) ? rawKind : "VECTOR";
  const schemaVersion = requiredString(row.schema_version, "schema_version");
  const source = compact({ authority: "GOWM_DATASET", sourceRef: optionalString(row.source_ref), sourceVersion: optionalString(row.source_version) });
  const rawQuality = isRecord(row.quality) ? row.quality : {};
  const validationStatus = typeof rawQuality.validationStatus === "string" && ["CERTIFIED", "VALIDATED", "UNCHECKED", "FAILED"].includes(rawQuality.validationStatus) ? rawQuality.validationStatus : "UNCHECKED";
  const quality = compact({
    completeness: optionalFinite(rawQuality.completeness),
    positionalAccuracyM: optionalFinite(rawQuality.positionalAccuracyM),
    temporalAccuracyMs: optionalFinite(rawQuality.temporalAccuracyMs),
    sourceReliability: optionalFinite(rawQuality.sourceReliability),
    validationStatus,
    knownLimitations: Array.isArray(rawQuality.knownLimitations) ? rawQuality.knownLimitations.filter((item): item is string => typeof item === "string") : []
  });
  return compact({
    schemaVersion: "1.0",
    referenceKey: referenceKeyValue(row.reference_key_value),
    dataKind,
    displayName: optionalString(row.name),
    currentVersion: requiredString(row.version, "version"),
    spatialExtent: isRecord(row.spatial_extent) ? row.spatial_extent : undefined,
    temporalExtent: timeRange(row.valid_from, row.valid_to),
    crs: optionalString(row.crs),
    schemaRef: `urn:gowm:dataset-schema:${schemaVersion}`,
    schemaHash: sha256({ schemaVersion }),
    source,
    lineage: Array.isArray(row.lineage) ? row.lineage.filter((item): item is string => typeof item === "string") : [],
    quality,
    freshnessPolicy: { mode: "VERSIONED", currentVersion: requiredString(row.version, "version") },
    supportedCapabilities: capabilitiesFor(dataKind, capabilityBindings),
    access: { dataScopeRequired: true, datasetScopeRequired: true }
  });
}

function capabilitiesFor(dataKind: string, bindings: CapabilityBinding[]): string[] {
  const compatible = bindings.filter(({ operationId, dataBinding }) => {
    if (dataKind === "CURRENT_PROJECTION") return dataBinding === "WORLD_SNAPSHOT_BOUND" && operationId.startsWith("world.");
    if (dataKind === "NETWORK") return ["WORLD_SNAPSHOT_BOUND", "DATASET_VERSION_BOUND"].includes(dataBinding) && /^(network|route|coverage)\./u.test(operationId);
    if (dataBinding !== "DATASET_VERSION_BOUND") return false;
    return /^(dataset|layer|feature|spatial)\./u.test(operationId);
  }).map(({ operationId }) => operationId);
  return [...new Set(compatible)].sort();
}

function qualityRank(status: string): number {
  return status === "CERTIFIED" ? 3 : status === "VALIDATED" ? 2 : status === "UNCHECKED" ? 1 : 0;
}

function optionalFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mapLayer(row: Row): Row {
  return compact({
    referenceKey: referenceKeyValue(row.reference_key_value),
    datasetReferenceKey: referenceKeyValue(row.dataset_reference_key_value),
    layerType: requiredString(row.layer_type, "layer_type"),
    name: requiredString(row.name, "name"),
    currentVersion: requiredString(row.version, "version"),
    geometryType: optionalString(row.geometry_type),
    crs: optionalString(row.crs),
    validTime: timeRange(row.valid_from, row.valid_to)
  });
}

function mapFeature(row: Row): Row {
  return compact({
    referenceKey: referenceKeyValue(row.reference_key_value),
    layerReferenceKey: referenceKeyValue(row.layer_reference_key_value),
    featureType: requiredString(row.feature_type, "feature_type"),
    displayName: optionalString(row.display_name),
    version: requiredString(row.version, "version"),
    geometrySummary: isRecord(row.geometry_summary) ? row.geometry_summary : undefined,
    properties: isRecord(row.properties) ? row.properties : {},
    validTime: timeRange(row.valid_from, row.valid_to)
  });
}

function mapQueryResultReference(row: Row): Row {
  return compact({
    referenceKey: referenceKeyValue(row.reference_key_value),
    queryId: requiredString(row.query_id, "query_id"),
    resultHash: requiredString(row.result_hash, "result_hash"),
    status: requiredString(row.status, "status"),
    resultSemantics: {
      schemaVersion: "1.0", normalizedStatus: requiredString(row.status, "status"),
      sourceStatus: isRecord(row.result_record) && typeof row.result_record.status === "string" ? row.result_record.status : requiredString(row.status, "status"),
      sourceAuthority: "gowm.result-registry", reasons: []
    },
    dataSnapshotHash: requiredString(row.data_snapshot_hash, "data_snapshot_hash"),
    computeSnapshotHash: requiredString(row.compute_snapshot_hash, "compute_snapshot_hash"),
    createdAt: date(row.created_at, "created_at"),
    validUntil: finiteDate(row.valid_until),
    artifactRefs: Array.isArray(row.artifact_refs) ? row.artifact_refs : []
  });
}

function mapObservation(row: Row, stateHistory: boolean): Row {
  return compact({
    recordKind: stateHistory ? "HISTORICAL_STATE_OBSERVATION" : "OBSERVATION",
    referenceKey: referenceKeyValue(row.reference_key_value),
    observationId: requiredString(row.observation_id, "observation_id"),
    observer: { type: requiredString(row.observer_type, "observer_type"), id: requiredString(row.observer_id, "observer_id") },
    subjectType: requiredString(row.subject_type, "subject_type"),
    observationType: requiredString(row.observation_type, "observation_type"),
    geometry: isRecord(row.geometry) ? row.geometry : undefined,
    value: isRecord(row.value) ? row.value : {},
    confidence: finite(row.confidence, "confidence"),
    observedAt: date(row.observed_at, "observed_at"),
    receivedAt: date(row.received_at, "received_at"),
    source: requiredString(row.source, "source"),
    correlationId: requiredString(row.correlation_id, "correlation_id"),
    status: requiredString(row.status, "status"),
    originKind: optionalString(row.origin_kind),
    sourceRecordKey: optionalString(row.source_record_key),
    sourceRevision: row.source_revision_no === null || row.source_revision_no === undefined
      ? undefined
      : safeInteger(row.source_revision_no, "source_revision_no"),
    supersedesObservationId: optionalString(row.supersedes_observation_id),
    rawReference: optionalString(row.raw_reference),
    payloadHash: optionalString(row.payload_hash),
    qualityFlags: Array.isArray(row.quality_flags) ? row.quality_flags : []
  });
}

function mapWorldEvent(row: Row): Row {
  return compact({
    recordKind: "WORLD_EVENT",
    referenceKey: referenceKeyValue(row.reference_key_value),
    eventId: requiredString(row.event_id, "event_id"),
    eventType: requiredString(row.event_type, "event_type"),
    subjectType: requiredString(row.subject_type, "subject_type"),
    eventTime: date(row.event_time, "event_time"),
    receivedAt: date(row.created_at, "created_at"),
    geometry: isRecord(row.geometry) ? row.geometry : undefined,
    worldVersion: safeInteger(row.world_version, "world_version"),
    correlationId: requiredString(row.correlation_id, "correlation_id"),
    causationId: requiredString(row.causation_id, "causation_id"),
    payload: isRecord(row.payload) ? row.payload : {},
    schemaVersion: requiredString(row.schema_version, "schema_version"),
    publishedAt: finiteDate(row.published_at)
  });
}

function worldNoData(
  referenceKey: ReferenceKey,
  snapshot: { context: DataSnapshotContext; worldVersion: number },
  unknown: string
): GroundingCatalogExecutionResult {
  return {
    ...result({ schemaVersion: "1.0", referenceKey, worldVersion: snapshot.worldVersion, facts: [], evidence: [], unknowns: [unknown] }, snapshot.context, 0, 0),
    status: "NO_DATA"
  };
}

function matchedBy(value: unknown): string {
  const mapping: Record<string, string> = {
    REFERENCE_KEY: "EXACT_REFERENCE_KEY", EXTERNAL_ID: "EXACT_EXTERNAL_ID", CODE: "EXACT_CODE",
    CANONICAL_NAME: "EXACT_CANONICAL_NAME", ALIAS: "EXACT_ALIAS", PINYIN: "PINYIN", FUZZY_NAME: "FUZZY_NAME"
  };
  return mapping[requiredString(value, "matched_by")] ?? "FUZZY_NAME";
}

function resolutionStatus(candidates: Row[]): string {
  if (candidates.length === 0) return "UNRESOLVED";
  if (candidates.length > 1) return "AMBIGUOUS";
  return candidates[0]?.matchedBy?.toString().startsWith("EXACT_") ? "RESOLVED_EXACT" : "SUGGESTED_UNIQUE";
}

function referenceId(value: unknown): string { return referenceKeyValue(value).id; }
function referenceKeyValue(value: unknown): ReferenceKey {
  if (!isRecord(value) || value.namespace !== "gowm" || typeof value.kind !== "string" || typeof value.id !== "string" || typeof value.version !== "string" || !/^wrf_[0-9a-f]{32}$/u.test(value.id)) {
    throw new ProviderProtocolError("INVALID_REQUEST", "invalid opaque reference key");
  }
  return { namespace: "gowm", kind: value.kind, id: value.id, version: value.version } as ReferenceKey;
}
function timeRange(from: unknown, to: unknown): Row | undefined {
  const result = compact({ from: finiteDate(from), to: finiteDate(to) });
  return Object.keys(result).length ? result : undefined;
}
function compact(value: Row): Row { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function date(value: unknown, name: string): string {
  const parsed = value instanceof Date ? value : new Date(requiredString(value, name));
  if (!Number.isFinite(parsed.getTime())) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `${name} is not a finite date`);
  return parsed.toISOString();
}
function finiteDate(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "infinity" || value === "-infinity") return undefined;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}
function asRecord(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderProtocolError("INVALID_REQUEST", "request must be an object");
  return value as Row;
}
function isRecord(value: unknown): value is Row { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `${name} must be a non-empty string`);
  return value;
}
function optionalString(value: unknown): string | null | undefined { return typeof value === "string" && value.length ? value : value === null ? null : undefined; }
function stringArrayOrNull(value: unknown): string[] | null { return Array.isArray(value) && value.length ? value.map((item) => requiredString(item, "array item")) : null; }
function safeInteger(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `${name} must be a non-negative safe integer`);
  return number;
}
function optionalInteger(value: unknown, fallback: number): number { return value === undefined ? fallback : safeInteger(value, "limit"); }
function finite(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `${name} must be finite`);
  return number;
}
function positive(value: number, name: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive`); return value; }
function bounded(value: number, maximum: number, name: string): number { const checked = positive(value, name); if (checked > maximum) throw new Error(`${name} must not exceed ${maximum}`); return checked; }
function budgetExceeded(maximum: number): ProviderProtocolError { return new ProviderProtocolError("BUDGET_EXCEEDED", "catalog candidate budget exceeded", { details: { maximumCandidates: maximum } }); }
function scopeOpaqueNotFound(kind: string): ProviderProtocolError {
  return new ProviderProtocolError("SCOPE_DENIED", `${kind} is unavailable in the authorized scope`, { retryable: false });
}
function mapDatabaseError(error: unknown): ProviderProtocolError {
  if (error instanceof ProviderProtocolError) return error;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (code === "42501") return new ProviderProtocolError("SCOPE_DENIED", "catalog scope is unavailable");
  if (code === "57014") return new ProviderProtocolError("DEADLINE_EXCEEDED", "catalog statement deadline exceeded", { cause: error });
  return new ProviderProtocolError("PROVIDER_NOT_READY", "catalog read contract execution failed", { retryable: true, cause: error });
}
