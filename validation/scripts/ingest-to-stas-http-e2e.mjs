#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Client } = require('../../node_modules/pg');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const ingest = (process.env.OBSERVATION_API_URL ?? 'http://127.0.0.1:3002').replace(/\/+$/, '');
const stas = (process.env.STAS_API_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const srid = Number(process.env.ANALYSIS_SRID ?? 32652);

async function json(url, options = {}) {
  const response = await fetch(url, { method: options.method ?? 'GET', headers: options.headers ?? { 'content-type': 'application/json' }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const value = JSON.parse(await response.text());
  return { status: response.status, value };
}

async function main() {
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const token = randomUUID().slice(0, 8);
  const scopeKey = `api-e2e-${token}`;
  const source = `camera-api-e2e-${token}`;
  const session = `session-api-e2e-${token}`;
  const base = Date.now() - 10_000;
  const versions = [];
  let finalInput;
  try {
    for (const [ordinal, offset, x, continuity] of [[1,0,448252,'a'],[2,1000,448253,'a'],[3,5000,448260,'b']]) {
      const start = new Date(base + offset).toISOString();
      finalInput = { schemaVersion:'1.2',observationId:`${source}:${token}-${ordinal}`,dataScopeKey:scopeKey,sourceRecordKey:`${token}-${ordinal}`,sourceRevisionNo:1,originKind:'PHYSICAL_SENSOR',observer:{type:'Camera',id:source},subject:{type:'ObservedTarget',id:`target-${token}`},sourceLocalTargetId:'17',trackerSessionId:session,observationType:'position',source,datastreamKey:`${source}:detections`,producerPipelineKey:`${source}:detector-v1`,rawReference:`inline://api-e2e/${token}/${ordinal}`,qualityFlags:[],metadata:{validation:true},timeSolution:{phenomenonTimeEstimate:start,phenomenonTimeWindow:{start,end:new Date(Date.parse(start)+1).toISOString()},uncertaintySeconds:0.02,correctionMethod:'API_E2E_CLOCK',clockModelVersion:'api-e2e-v1'},measurements:[{measurementKey:'position',measurementStage:'NORMALIZED',observedProperty:'position',resultKind:'POSITION',analysisSpaceKey:'default',position:{x,y:4417768,srid},sourceGeometry:{type:'Point',coordinates:[116.4+(x-448252)/100000,39.9]},uncertainty:{model:'HARD_RADIUS',unit:'m',horizontalValue:5,confidenceLevel:0.95},measurementModel:'API_E2E_POSITION',measurementModelVersion:'1.0',algorithmConfidence:0.9,qualityScore:0.9,qualityFlags:[],continuityToken:`${session}:17:${continuity}`,manualCutBefore:false,attributes:{}}],assertions:[],entityBindingStatus:'DECLARED' };
      const response = await json(`${ingest}/observations`, { method:'POST', body:finalInput });
      assert.equal(response.status, 202, JSON.stringify(response.value));
      versions.push(response.value.trackletVersionId);
    }
    assert.equal(new Set(versions).size, 3);
    const replay = await json(`${ingest}/observations`, { method:'POST', body:finalInput });
    assert.equal(replay.status, 200);
    assert.equal(replay.value.status, 'duplicate');
    const canonical = await json(`${ingest}/observations/${encodeURIComponent(finalInput.observationId)}/canonical`, { headers: { accept:'application/json' } });
    assert.equal(canonical.status, 200);
    assert.equal(canonical.value.canonicalEvidenceContractVersion, '1.2');
    const authority = await db.query(`SELECT ds.data_scope_id,t.tracklet_id,h.current_version_id,v.sequence_count,(SELECT count(*)::integer FROM mobility_tracklet_gap g WHERE g.tracklet_version_id=v.tracklet_version_id) gap_count FROM data_scope ds JOIN mobility_tracklet t ON t.data_scope_key=ds.scope_key JOIN mobility_tracklet_head h USING(tracklet_id) JOIN mobility_tracklet_version v ON v.tracklet_version_id=h.current_version_id WHERE ds.scope_key=$1 AND t.source_key=$2`,[scopeKey,source]);
    const row=authority.rows[0]; assert.ok(row); assert.equal(row.sequence_count,2); assert.equal(row.gap_count,1);
    const input={dataScopeId:row.data_scope_id,snapshotPolicy:'PINNED',evidenceLevel:'FULL',tracklet:{trackletId:row.tracklet_id,trackletVersionId:row.current_version_id},timeRange:{start:new Date(base-1000).toISOString(),end:new Date(base+7000).toISOString(),bounds:'[)'},reasons:[],limit:20};
    const analysis=await json(`${stas}/v1/tools/get_tracklet_gaps:execute`,{method:'POST',headers:{'content-type':'application/json','x-data-scope-id':row.data_scope_id},body:input});
    assert.equal(analysis.status,200,JSON.stringify(analysis.value));
    assert.ok(analysis.value.result.items.some((gap)=>gap.observability_state==='UNKNOWN'));
    const evidence={status:'PASS',generatedAt:new Date().toISOString(),scopeKey,dataScopeId:row.data_scope_id,observationCount:3,trackletVersionCount:3,exactReplayStatus:'duplicate',finalTrackletVersionId:row.current_version_id,sequenceCount:row.sequence_count,gapCount:row.gap_count,analysisId:analysis.value.analysisId,mqttDelivery:'PARTIAL_DURABLE_QUEUE_ONLY'};
    await mkdir('validation/evidence',{recursive:true}); await writeFile('validation/evidence/ingest-to-stas.json',`${JSON.stringify(evidence,null,2)}\n`); process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally { await db.end(); }
}
main().catch((error)=>{console.error(error);process.exitCode=1;});
