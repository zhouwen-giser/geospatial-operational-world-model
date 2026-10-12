import {z} from 'zod';
import {canonicalJson} from '../../../observation-model/src/canonical.js';
import {sha256,UGV_AUTHORITY_TOPICS,type UgvAuthorityTopic} from './contracts.js';
import type {CanonicalObservationInput} from '../../../world-model-core/src/types.js';

export const PROFILED_MAPPER_VERSION='ugv-mqtt-canonical-v4';
const tick=z.string().regex(/^-?\d{1,24}$/);
const identifier=z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/);
const Anchor=z.object({ticks:tick,utc:z.iso.datetime({offset:true}),evidenceReference:z.string().min(1).max(512)}).strict();
export const ClockCalibrationSchema=z.object({
 calibrationId:identifier,version:identifier,sourceKey:z.string().min(1),dataScopeKey:z.string().min(1),
 worldEpoch:z.string().min(1),trackerSessionKey:z.string().min(1),
 encoding:z.enum(['TIME_US','CAPTURE_TIME_US','ROS_STAMP']),
 unit:z.enum(['MICROSECONDS','NANOSECONDS']),anchors:z.tuple([Anchor,Anchor]),
 validFromTicks:tick,validToTicks:tick,uncertaintyMs:z.number().finite().min(0).max(60000),
 maximumDriftPpm:z.number().finite().min(0).max(100000),driftErrorPpm:z.number().finite().min(0).max(100000)
}).strict().superRefine((v,c)=>{
 const a=BigInt(v.anchors[0].ticks),b=BigInt(v.anchors[1].ticks),lo=BigInt(v.validFromTicks),hi=BigInt(v.validToTicks);
 const scale=v.unit==='MICROSECONDS'?1e6:1e9;
 if(a>=b||lo>a||hi<b||Number(hi-lo)/scale>7*86400)c.addIssue({code:'custom',message:'CLOCK_CALIBRATION_TICK_BOUNDS_INVALID'});
 const ms=Date.parse(v.anchors[1].utc)-Date.parse(v.anchors[0].utc);
 const ppm=(ms/1000/(Number(b-a)/scale)-1)*1e6;
 if(ms<=0||!Number.isFinite(ppm)||Math.abs(ppm)>v.maximumDriftPpm)c.addIssue({code:'custom',message:'CLOCK_CALIBRATION_DRIFT_INVALID'});
 if((v.encoding==='ROS_STAMP')!==(v.unit==='NANOSECONDS'))c.addIssue({code:'custom',message:'CLOCK_CALIBRATION_UNIT_ENCODING_MISMATCH'});
});
export type ClockCalibration=z.infer<typeof ClockCalibrationSchema>;
const Clock=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('ARRIVAL_PROXY')}).strict(),
 z.object({mode:z.literal('CALIBRATED'),calibration:ClockCalibrationSchema}).strict()
]);
export const UgvRuntimeProfileSchema=z.object({
 schemaVersion:z.literal('1.0'),adapter:z.literal('ROS2_UGV_7_V1'),profileId:identifier,version:identifier,
 sourceSchemaLockSha256:z.string().regex(/^[0-9a-f]{64}$/),dataScopeKey:z.string().min(1),sourceKey:z.string().min(1),
 deviceId:z.string().min(1),endpointKey:z.string().min(1),worldEpoch:z.string().min(1),trackerSessionKey:z.string().min(1),
 analysisSpaceKey:z.string().min(1),analysisSrid:z.number().int().positive(),originKind:z.enum(['SIMULATION','PHYSICAL_SENSOR']),
 routes:z.array(z.object({topic:z.enum(UGV_AUTHORITY_TOPICS),messageProfile:z.literal('ugv-mqtt'),enabled:z.boolean(),qos:z.union([z.literal(0),z.literal(1)]),clock:Clock}).strict()).length(7)
}).strict().superRefine((p,c)=>{
 if(new Set(p.routes.map(r=>r.topic)).size!==7||!p.routes.some(r=>r.enabled))c.addIssue({code:'custom',message:'PROFILE_ROUTE_SET_INVALID'});
 for(const r of p.routes){
  if(r.qos===0&&r.topic!=='/ugv/speed')c.addIssue({code:'custom',message:'PROFILE_QOS0_ONLY_SPEED'});
  if(r.clock.mode==='CALIBRATED'){
   const m=r.clock.calibration;
   if(m.sourceKey!==p.sourceKey||m.dataScopeKey!==p.dataScopeKey||m.worldEpoch!==p.worldEpoch||m.trackerSessionKey!==p.trackerSessionKey)
    c.addIssue({code:'custom',message:'PROFILE_CLOCK_IDENTITY_MISMATCH'});
  }
 }
});
export type UgvRuntimeProfile=z.infer<typeof UgvRuntimeProfileSchema>;
export const runtimeProfileHash=(p:UgvRuntimeProfile)=>sha256(canonicalJson(p));

export function profileTime(payload:unknown,topic:UgvAuthorityTopic,receivedAt:string,arrivalUncertaintyMs:number,profile?:UgvRuntimeProfile):CanonicalObservationInput['timeSolution'] {
 const clock=profile?.routes.find(r=>r.topic===topic&&r.enabled)?.clock;
 if(profile&&!clock)throw Error('PROFILE_TOPIC_DISABLED');
 if(!clock||clock.mode==='ARRIVAL_PROXY')return {phenomenonTimeEstimate:receivedAt,
  phenomenonTimeWindow:{start:new Date(Date.parse(receivedAt)-arrivalUncertaintyMs).toISOString(),end:new Date(Date.parse(receivedAt)+arrivalUncertaintyMs+1).toISOString()},
  uncertaintySeconds:arrivalUncertaintyMs/1000,correctionMethod:'MQTT_ADAPTER_RECEIVE_TIME_PROXY',clockModelVersion:'mqtt-arrival-proxy-v1',clockDomain:'ADAPTER_WALL_CLOCK'};
 const model=ClockCalibrationSchema.parse(clock.calibration),p=payload as Record<string,unknown>;
 const integer=(v:unknown)=>{if(typeof v==='number'&&!Number.isSafeInteger(v))throw Error('SOURCE_TICK_PRECISION_UNSAFE');
  if(!['number','string'].includes(typeof v)||! /^-?\d{1,24}$/.test(String(v)))throw Error('SOURCE_TICK_MISSING_OR_INVALID');return BigInt(String(v));};
 let ticks:bigint;
 if(model.encoding==='ROS_STAMP'){
  const stamp=(p?.header as {stamp?:{sec?:unknown;nanosec?:unknown}})?.stamp;
  const seconds=integer(stamp?.sec),nanos=integer(stamp?.nanosec);
  if(nanos<0||nanos>=1000000000n)throw Error('SOURCE_ROS_NANOSECOND_INVALID');ticks=seconds*1000000000n+nanos;
 }else ticks=integer(p?.[model.encoding==='TIME_US'?'time_us':'capture_time_us']);
 if(ticks<BigInt(model.validFromTicks)||ticks>BigInt(model.validToTicks))throw Error('SOURCE_TICKS_OUTSIDE_CALIBRATION');
 const a=model.anchors[0],b=model.anchors[1],delta=Number(ticks-BigInt(a.ticks));
 const span=Number(BigInt(b.ticks)-BigInt(a.ticks)),ms=Date.parse(b.utc)-Date.parse(a.utc);
 const scale=model.unit==='MICROSECONDS'?1e6:1e9,driftPpm=(ms/1000/(span/scale)-1)*1e6;
 const estimateMs=Math.round(Date.parse(a.utc)+delta/span*ms);
 const bound=model.uncertaintyMs+Math.abs(delta/scale)*model.driftErrorPpm/1000+1;
 const hash=sha256(canonicalJson(model)),identityHash=sha256(canonicalJson({calibration:model,profileId:profile!.profileId,profileVersion:profile!.version})),version='calibrated-'+identityHash.slice(0,48);
 return {phenomenonTimeEstimate:new Date(estimateMs).toISOString(),phenomenonTimeWindow:{start:new Date(estimateMs-bound).toISOString(),end:new Date(estimateMs+bound+1).toISOString()},
  uncertaintySeconds:bound/1000,correctionMethod:'TWO_ANCHOR_AFFINE_TICKS_V1',clockModelVersion:version,
  clockDomain:'CALIBRATED_'+model.unit,clockOffsetSeconds:Date.parse(a.utc)/1000-Number(BigInt(a.ticks))/scale*(1+driftPpm/1e6),
  clockDriftPpm:driftPpm,clockResidualSigmaMs:0,clockEstimationMethod:'TWO_ANCHOR_AFFINE_TICKS_V1',
  clockCalibrationReference:'ugv-profile://'+profile!.profileId+'/'+profile!.version+'/'+hash,
  sourceTimeTicks:ticks.toString(),sourceTimeRaw:model.encoding==='ROS_STAMP'?canonicalJson((p.header as {stamp:unknown}).stamp):String(p[model.encoding==='TIME_US'?'time_us':'capture_time_us'])};
}
