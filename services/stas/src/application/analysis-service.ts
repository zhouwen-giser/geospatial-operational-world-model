import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import type { AnalysisResult, EvidenceRef, RepositoryExecution } from '../domain/analysis.js';
import { semanticAnalysisHash } from '../domain/canonical-json.js';
import { AppError, validationError } from '../domain/errors.js';
import type { ToolRepository } from '../repositories/tool-repository.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolInput, ToolName } from '../tools/schemas.js';

export function sqlTemplateSequenceHash(
  templateId: string,
  statements: ReadonlyArray<{ text: string; values?: readonly unknown[] }>,
): string {
  return semanticAnalysisHash({
    templateId,
    statements: statements.map((statement) => statement.text.replaceAll('\r\n', '\n').trim()),
  });
}

export function buildSnapshotEvidence(execution: RepositoryExecution): EvidenceRef[] {
  const refs: EvidenceRef[] = [...(execution.evidence ?? [])];
  for (const version of execution.snapshot.trackletVersions) {
    refs.push({ id: version.trackletVersionId, type: 'TRACKLET_VERSION' });
  }
  for (const id of execution.snapshot.spatialObjectVersionIds ?? []) refs.push({ id, type: 'SPATIAL_OBJECT_VERSION' });
  for (const id of execution.snapshot.coverageSliceIds ?? []) refs.push({ id, type: 'COVERAGE_SLICE' });
  const unique = new Map<string, EvidenceRef>();
  for (const ref of refs) {
    const key = `${ref.type}:${ref.id}`;
    unique.set(key, { ...ref, summaryHash: ref.summaryHash ?? semanticAnalysisHash({ type: ref.type, id: ref.id }) });
  }
  return [...unique.values()];
}

export class AnalysisService {
  public constructor(
    private readonly database: Database,
    private readonly repository: ToolRepository,
    private readonly registry: ToolRegistry,
    private readonly config: Config,
  ) {}

  public async execute(name: string, input: unknown): Promise<AnalysisResult<unknown>> {
    const definition = this.registry.get(name);
    if (definition === undefined) {
      throw new AppError('NOT_FOUND', 404, 'Tool not found', `No registered v1 tool is named ${name}.`);
    }
    const parsed = definition.schema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const toolInput = parsed.data as ToolInput;
    const deadlineMs = toolInput.deadlineMs ?? definition.defaultTimeoutMs;
    if (deadlineMs > definition.maxTimeoutMs) {
      throw new AppError('INVALID_ARGUMENT', 400, 'Deadline exceeds tool maximum', `deadlineMs must not exceed ${definition.maxTimeoutMs}.`);
    }
    const analysisId = randomUUID();
    const startedAt = performance.now();
    return this.database.withTransaction(deadlineMs, 'REPEATABLE_READ', async (transaction) => {
      const runtimeMetadata = await transaction.runtimeMetadata();
      const statementOffset = transaction.executedStatementCount;
      const execution = await this.repository.execute(definition.name as ToolName, toolInput, transaction);
      const sqlTemplateHash = sqlTemplateSequenceHash(
        execution.sqlTemplateId,
        transaction.executedStatementsSince(statementOffset),
      );
      const result = this.envelope(
        analysisId,
        definition.name,
        definition.version,
        toolInput,
        execution,
        transaction.databaseSnapshotId,
        performance.now() - startedAt,
        runtimeMetadata,
        sqlTemplateHash,
      );
      const persistedAnalysisId = await this.repository.persistAnalysisRecord(result, transaction);
      result.analysisId = persistedAnalysisId;
      return result;
    });
  }

  public async get(analysisId: string, dataScopeId: string): Promise<AnalysisResult<unknown>> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(analysisId)) {
      throw new AppError('INVALID_ARGUMENT', 400, 'Invalid analysis identifier', 'analysisId must be an RFC 4122 UUID.');
    }
    return this.database.withTransaction(2000, 'REPEATABLE_READ', async (transaction) => {
      const found = await transaction.query<{
        analysis_id: string;
        status: AnalysisResult<unknown>['status'];
        analysis_as_of: Date;
        query_payload: Record<string, unknown>;
        result_payload: Omit<AnalysisResult<unknown>, 'analysisId' | 'schemaVersion' | 'generatedAt' | 'query' | 'status' | 'method' | 'snapshot'>;
        method_snapshot: Pick<AnalysisResult<unknown>, 'method' | 'snapshot'>;
      }>(`
        SELECT analysis_id,status,analysis_as_of,query_payload,result_payload,method_snapshot
        FROM stas.analysis_record ar
        JOIN gowm_stas_v1.data_scope ds ON ds.tenant_key=ar.data_scope_key
        WHERE ar.analysis_id=$1::uuid AND ds.data_scope_id=$2::uuid
      `, [analysisId, dataScopeId]);
      const row = found.rows[0];
      if (row === undefined) throw new AppError('NOT_FOUND', 404, 'Analysis not found', 'No persisted analysis has this identifier.');
      return {
        schemaVersion: '1.0',
        analysisId: row.analysis_id,
        status: row.status,
        generatedAt: row.analysis_as_of.toISOString(),
        query: row.query_payload,
        ...row.result_payload,
        method: row.method_snapshot.method,
        snapshot: row.method_snapshot.snapshot,
      };
    });
  }

  private envelope(
    analysisId: string,
    tool: ToolName,
    toolVersion: string,
    input: ToolInput,
    execution: RepositoryExecution,
    databaseSnapshotId: string,
    elapsedMs: number,
    runtimeMetadata: { mobilityDbVersion: string; postgisVersion: string },
    sqlTemplateHash: string,
  ): AnalysisResult<unknown> {
    return {
      schemaVersion: '1.0',
      analysisId,
      status: execution.status,
      generatedAt: new Date().toISOString(),
      subjects: execution.subjects,
      query: input,
      result: execution.result,
      coverage: execution.coverage ?? {},
      evidence: buildSnapshotEvidence(execution),
      gaps: execution.gaps ?? [],
      uncertainties: execution.uncertainties ?? [],
      assumptions: execution.assumptions ?? [],
      sourceReferences: execution.sourceReferences ?? [],
      quality: execution.quality ?? { grade: 'UNKNOWN', flags: [] },
      method: {
        tool,
        toolVersion,
        algorithm: execution.algorithm,
        algorithmVersion: '1',
        mobilityDbVersion: runtimeMetadata.mobilityDbVersion,
        postgisVersion: runtimeMetadata.postgisVersion,
        interpolationPolicy: execution.interpolationPolicy ?? 'NOT_APPLICABLE',
        uncertaintyPolicy: execution.uncertaintyPolicy ?? 'REPORT_ONLY',
        metricDimension: '2D',
        sqlTemplateHash,
      },
      snapshot: {
        dataScopeId: input.dataScopeId,
        databaseSnapshotId,
        ...execution.snapshot,
      },
      warnings: execution.warnings ?? [],
      ...(execution.page === undefined ? {} : { page: execution.page }),
      execution: {
        elapsedMs: Math.round(elapsedMs * 1000) / 1000,
        ...(execution.candidateCount === undefined ? {} : { candidateCount: execution.candidateCount }),
        ...(execution.exactCount === undefined ? {} : { exactCount: execution.exactCount }),
        cacheHit: false,
      },
    };
  }
}
