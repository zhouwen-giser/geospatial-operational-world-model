import {describe,it,expect} from 'vitest';
import {ClockCalibrationSchema,UgvRuntimeProfileSchema,profileTime,type ClockCalibration,type UgvRuntimeProfile} from '../../packages/integrations/ugv-mqtt-ingest-core/src/runtime-profile.js';
import {UGV_AUTHORITY_TOPICS} from '../../packages/integrations/ugv-mqtt-ingest-core/src/contracts.js';
import {subscriptionPlan} from '../../services/ugv-mqtt-ingest/src/app.js';

export function calibration():ClockCalibration{return {calibrationId:'test-clock',version:'v1',sourceKey:'source',dataScopeKey:'scope',worldEpoch:'epoch',trackerSessionKey:'session',encoding:'ROS_STAMP',unit:'NANOSECONDS',
 anchors:[{ticks:'1000000000000',utc:'2026-10-12T00:00:00.000Z',evidenceReference:'test://anchor-1'},
 {ticks:'1010000000000',utc:'2026-10-12T00:00:10.000Z',evidenceReference:'test://anchor-2'}],validFromTicks:'1000000000000',validToTicks:'1020000000000',uncertaintyMs:2,maximumDriftPpm:100,driftErrorPpm:1};}
export function profile():UgvRuntimeProfile{return {schemaVersion:'1.0',adapter:'ROS2_UGV_7_V1',profileId:'test-profile',version:'v1',sourceSchemaLockSha256:'a'.repeat(64),dataScopeKey:'scope',sourceKey:'source',deviceId:'master:ugv',endpointKey:'endpoint',worldEpoch:'epoch',trackerSessionKey:'session',analysisSpaceKey:'space',analysisSrid:32648,originKind:'SIMULATION',
 routes:UGV_AUTHORITY_TOPICS.map(topic=>({topic,messageProfile:'ugv-mqtt',enabled:true,qos:1,clock:topic==='/ugv/gnss'?{mode:'CALIBRATED',calibration:calibration()}:{mode:'ARRIVAL_PROXY'}}))};}
describe('versioned UGV source clock',()=>{
 it('keeps all seven default subscriptions and the reset control route, while honoring profile disable and QoS',()=>{
  expect(subscriptionPlan({})).toEqual({...Object.fromEntries(UGV_AUTHORITY_TOPICS.map(t=>[t,1])),'/sim/reset_ack':1});
  const p=profile();p.routes.find(r=>r.topic==='/ugv/gnss')!.enabled=false;
  p.routes.find(r=>r.topic==='/ugv/speed')!.qos=0;
  const plan=subscriptionPlan({runtimeProfile:p});expect(plan['/ugv/gnss']).toBeUndefined();
  expect(plan['/ugv/speed']).toBe(0);expect(plan['/sim/reset_ack']).toBe(1);expect(Object.keys(plan)).toHaveLength(7);
 });
 it('uses exact source tick deltas despite delayed batch arrival and preserves the declared uncertainty',()=>{
  const p=profile();const a=profileTime({header:{stamp:{sec:1001,nanosec:250000000}}},'/ugv/gnss','2026-10-12T01:00:00Z',1000,p);
  expect(a.phenomenonTimeEstimate).toBe('2026-10-12T00:00:01.250Z');expect(a.uncertaintySeconds).toBeGreaterThan(.002);
  expect(a.sourceTimeTicks).toBe('1001250000000');expect(a.correctionMethod).toBe('TWO_ANCHOR_AFFINE_TICKS_V1');
  expect(profileTime({header:{stamp:{sec:1001,nanosec:250000000}}},'/ugv/gnss','2026-10-12T02:00:00Z',1000,p)).toEqual(a);
 });
 it('rejects reset ticks, missing source time, invalid nanoseconds, unsafe numeric ticks and invalid calibration',()=>{
  const p=profile();
  for(const payload of [{},{header:{stamp:{sec:0,nanosec:0}}},{header:{stamp:{sec:1001,nanosec:1000000000}}}])
   expect(()=>profileTime(payload,'/ugv/gnss','2026-10-12T01:00:00Z',1000,p)).toThrow();
  const bad=calibration();bad.anchors[1].utc='2026-10-12T00:01:00Z';expect(()=>ClockCalibrationSchema.parse(bad)).toThrow();
  const micro=calibration();micro.encoding='TIME_US';micro.unit='MICROSECONDS';micro.anchors[0].ticks='1000000';micro.anchors[1].ticks='11000000';micro.validFromTicks='1000000';micro.validToTicks='21000000';
  p.routes[0]!.clock={mode:'CALIBRATED',calibration:micro};expect(()=>profileTime({time_us:Number.MAX_SAFE_INTEGER+1},'/ugv/gnss','2026-10-12T01:00:00Z',1000,p)).toThrow('PRECISION_UNSAFE');
 });
 it('keeps explicit arrival proxy and rejects ambiguous, disabled, cross-session or unsupported routes',()=>{
  const p=profile();expect(UgvRuntimeProfileSchema.parse(p)).toEqual(p);
  expect(profileTime(36,'/ugv/speed','2026-10-12T00:00:01Z',1000,p).clockModelVersion).toBe('mqtt-arrival-proxy-v1');
  p.routes[0]!.enabled=false;expect(()=>profileTime({},'/ugv/gnss','2026-10-12T00:00:01Z',1000,p)).toThrow('TOPIC_DISABLED');
  const other=profile();other.trackerSessionKey='another';expect(()=>UgvRuntimeProfileSchema.parse(other)).toThrow('CLOCK_IDENTITY');
  other.routes[1]!.topic='/ugv/gnss';expect(()=>UgvRuntimeProfileSchema.parse(other)).toThrow('ROUTE_SET');
 });
});
