import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { buildObservationApp } from '../../services/observation-ingest/src/app.js';
import { closeDatabasePool } from '../../packages/runtime/src/db.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const stasUrl = (process.env.STAS_API_URL ?? 'http://127.0.0.1:18080').replace(/\/+$/, '');
const analysisSrid = Number(process.env.ANALYSIS_SRID ?? 32652);

async function main(): Promise<void> {
  const app = buildObservationApp();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const token = randomUUID().slice(0, 8);
  const scopeKey = `api-e2e-${token}`;
  const source = `camera-api-e2e-${token}`;
  const trackerSession = `session-api-e2e-${token}`;
  const subjectId = `target-api-e2e-${token}`;
  const base = Date.now() - 10_000;
  const versions: string[] = [];
  let finalPayload: Record<string, unknown> | undefined;
  try {
    for (const [ordinal, offsetMs, x, continuity] of [
      [1, 0, 448252, 'a'], [2, 1000, 448253, 'a'], [3, 5000, 448260, 'b'],
    ] as const) {
      const start = new Date(base + offsetMs).toISOString();
      const payload = canonicalInput({ token, ordinal, scopeKey, source, trackerSession, subjectId, start, x, continuity });
      const response = await app.inject({ method: 'POST', url: '/observations', payload });
      assert.equal(response.statusCode, 202, response.body);
      const body = response.json<Record<string, unknown>>();
      assert.equal(body.status, 'accepted');
      assert.equal(body.canonicalContractVersion, '1.2');
      assert.equal(typeof body.trackletVersionId, 'string');
      versions.push(String(body.trackletVersionId));
      finalPayload = payload;
    }
    assert.equal(new Set(versions).size, 3, 'each append must publish an immutable TrackletVersion');

    const replay = await app.inject({ method: 'POST', url: '/observations', payload: finalPayload });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().status, 'duplicate');
    assert.equal(replay.json().trackletVersionId, versions.at(-1));

    const canonical = await app.inject({ method: 'GET', url: `/observations/${encodeURIComponent(`${source}:${token}-3`)}/canonical` });
    assert.equal(canonical.statusCode, 200, canonical.body);
    assert.equal(canonical.json().canonicalEvidenceContractVersion, '1.2');
    assert.equal(canonical.json().measurements.length, 1);

    const authority = await client.query<{ data_scope_id: string; tracklet_id: string; current_version_id: string; sequence_count: number; gap_count: number }>(`
      SELECT ds.data_scope_id,t.tracklet_id,h.current_version_id,v.sequence_count,
             (SELECT count(*)::integer FROM mobility_tracklet_gap g WHERE g.tracklet_version_id=v.tracklet_version_id) AS gap_count
      FROM data_scope ds
      JOIN mobility_tracklet t ON t.data_scope_key=ds.scope_key
      JOIN mobility_tracklet_head h USING(tracklet_id)
      JOIN mobility_tracklet_version v ON v.tracklet_version_id=h.current_version_id
      WHERE ds.scope_key=$1 AND t.source_key=$2 AND t.source_local_target_id='17'
    `, [scopeKey, source]);
    const row = authority.rows[0];
    assert.ok(row);
    assert.equal(row.current_version_id, versions.at(-1));
    assert.equal(Number(row.sequence_count), 2);
    assert.equal(Number(row.gap_count), 1);

    const input = {
      dataScopeId: row.data_scope_id, snapshotPolicy: 'PINNED', evidenceLevel: 'FULL',
      tracklet: { trackletId: row.tracklet_id, trackletVersionId: row.current_version_id },
      timeRange: { start: new Date(base - 1000).toISOString(), end: new Date(base + 7000).toISOString(), bounds: '[)' },
      reasons: [], limit: 20,
    };
    const analysisResponse = await fetch(`${stasUrl}/v1/tools/get_tracklet_gaps:execute`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-data-scope-id': row.data_scope_id }, body: JSON.stringify(input),
    });
    const analysis = await analysisResponse.json() as Record<string, any>;
    assert.equal(analysisResponse.status, 200, JSON.stringify(analysis));
    assert.equal(analysis.status, 'COMPLETE');
    assert.ok(analysis.result.items.some((gap: Record<string, unknown>) => gap.observability_state === 'UNKNOWN'));
    assert.ok(analysis.evidence.some((item: Record<string, unknown>) => item.type === 'TRACKLET_VERSION' && item.id === row.current_version_id));

    const stored = await client.query('SELECT data_scope_key,status FROM stas.analysis_record WHERE analysis_id=$1::uuid', [analysis.analysisId]);
    assert.equal(stored.rows[0]?.data_scope_key, scopeKey);
    assert.equal(stored.rows[0]?.status, 'COMPLETE');
    const evidence = { status: 'PASS', generatedAt: new Date().toISOString(), scopeKey, dataScopeId: row.data_scope_id,
      observationCount: 3, trackletVersionCount: versions.length, exactReplayStatus: 'duplicate',
      finalTrackletVersionId: row.current_version_id, sequenceCount: row.sequence_count, gapCount: row.gap_count,
      analysisId: analysis.analysisId, mqttDelivery: 'PARTIAL_DURABLE_QUEUE_ONLY' };
    await mkdir('validation/evidence', { recursive: true });
    await writeFile('validation/evidence/ingest-to-stas.json', `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    await app.close();
    await closeDatabasePool();
    await client.end();
  }
}

function canonicalInput(input: { token: string; ordinal: number; scopeKey: string; source: string; trackerSession: string; subjectId: string; start: string; x: number; continuity: string }): Record<string, unknown> {
  return {
    schemaVersion: '1.2', observationId: `${input.source}:${input.token}-${input.ordinal}`,
    dataScopeKey: input.scopeKey, sourceRecordKey: `${input.token}-${input.ordinal}`, sourceRevisionNo: 1,
    originKind: 'PHYSICAL_SENSOR', observer: { type: 'Camera', id: input.source },
    subject: { type: 'ObservedTarget', id: input.subjectId }, sourceLocalTargetId: '17', trackerSessionId: input.trackerSession,
    observationType: 'position', source: input.source, datastreamKey: `${input.source}:detections`, producerPipelineKey: `${input.source}:detector-v1`,
    rawReference: `inline://api-e2e/${input.token}/${input.ordinal}`, qualityFlags: [], metadata: { validation: true },
    timeSolution: { phenomenonTimeEstimate: input.start, phenomenonTimeWindow: { start: input.start, end: new Date(Date.parse(input.start) + 1).toISOString() }, uncertaintySeconds: 0.02, correctionMethod: 'API_E2E_CLOCK', clockModelVersion: 'api-e2e-v1' },
    measurements: [{ measurementKey: 'position', measurementStage: 'NORMALIZED', observedProperty: 'position', resultKind: 'POSITION', analysisSpaceKey: 'default', position: { x: input.x, y: 4417768, srid: analysisSrid }, sourceGeometry: { type: 'Point', coordinates: [116.4 + (input.x - 448252) / 100000, 39.9] }, uncertainty: { model: 'HARD_RADIUS', unit: 'm', horizontalValue: 5, confidenceLevel: 0.95 }, measurementModel: 'API_E2E_POSITION', measurementModelVersion: '1.0', algorithmConfidence: 0.9, qualityScore: 0.9, qualityFlags: [], continuityToken: `${input.trackerSession}:17:${input.continuity}`, manualCutBefore: false, attributes: {} }],
    assertions: [], entityBindingStatus: 'DECLARED',
  };
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
