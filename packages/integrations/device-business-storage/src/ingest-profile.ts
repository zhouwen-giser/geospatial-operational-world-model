import type {PoolClient} from 'pg';
import {UgvRuntimeProfileSchema,runtimeProfileHash,type UgvRuntimeProfile} from '../../ugv-mqtt-ingest-core/src/runtime-profile.js';

export async function loadRuntimeProfile(c:PoolClient,scope:string,deviceId:string,profileId:string,version:string):Promise<UgvRuntimeProfile>{
 const row=(await c.query(`SELECT profile,content_hash FROM gowm_device.ingest_runtime_profile
  WHERE data_scope_key=$1 AND device_id=$2 AND profile_id=$3 AND profile_version=$4`,[scope,deviceId,profileId,version])).rows[0];
 if(!row)throw Error('INGEST_RUNTIME_PROFILE_NOT_FOUND');
 const p=UgvRuntimeProfileSchema.parse(row.profile);if(row.content_hash!==runtimeProfileHash(p))throw Error('INGEST_RUNTIME_PROFILE_HASH_MISMATCH');
 const analysis=(await c.query('SELECT canonical_srid FROM analysis_space WHERE analysis_space_key=$1',[p.analysisSpaceKey])).rows[0];
 if(Number(analysis?.canonical_srid)!==p.analysisSrid)throw Error('INGEST_RUNTIME_PROFILE_ANALYSIS_SPACE_MISMATCH');
 return p;
}

export async function loadActiveRuntimeProfile(c:PoolClient,scope:string,deviceId:string){
 const a=(await c.query('SELECT profile_id,profile_version FROM gowm_device.ingest_profile_activation WHERE data_scope_key=$1 AND device_id=$2',[scope,deviceId])).rows[0];
 return a?loadRuntimeProfile(c,scope,deviceId,a.profile_id,a.profile_version):undefined;
}

export async function activateRuntimeProfile(c:PoolClient,scope:string,deviceId:string,profileId:string,version:string){
 const p=await loadRuntimeProfile(c,scope,deviceId,profileId,version);
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,92012))',[scope]);
 const sessions=await c.query(`SELECT session_id FROM ugv_ingest.mqtt_session WHERE (
  mapper_context#>>'{deviceContext,deviceId}'=$1 OR mapper_context->>'deviceId' IN(
   SELECT device_identifier FROM gowm_device.device WHERE device_id=$1 AND data_scope_key=$2))
  AND mapper_context->>'dataScopeKey'=$2 AND closed_at IS NULL FOR UPDATE`,[deviceId,scope]);
 if(sessions.rowCount)throw Error('INGEST_PROFILE_REQUIRES_CLOSED_SESSIONS');
 for(const r of p.routes){
  const changed=await c.query(`UPDATE gowm_device.device_stream s SET enabled=$5,qos=$6,message_profile=$7,
   mapper_config=jsonb_build_object('runtimeProfileId',$3::text,'runtimeProfileVersion',$4::text)
   FROM gowm_device.mqtt_endpoint e WHERE s.endpoint_id=e.endpoint_id AND e.endpoint_key=$8
    AND s.device_id=$1 AND s.data_scope_key=$2 AND s.topic_filter=$9`,
   [deviceId,scope,profileId,version,r.enabled,r.qos,r.messageProfile,p.endpointKey,r.topic]);
  if(changed.rowCount!==1)throw Error('INGEST_PROFILE_REQUIRES_EXACT_UNIQUE_ROUTES');
 }
 await c.query(`INSERT INTO gowm_device.ingest_profile_activation(data_scope_key,device_id,profile_id,profile_version)
  VALUES($1,$2,$3,$4) ON CONFLICT(data_scope_key,device_id) DO UPDATE SET profile_id=EXCLUDED.profile_id,
  profile_version=EXCLUDED.profile_version,activated_at=clock_timestamp()`,[scope,deviceId,profileId,version]);
 return {profileId,version,hash:runtimeProfileHash(p),nextSessionRequired:true};
}

export async function registerRuntimeProfile(c:PoolClient,input:unknown){
 const p=UgvRuntimeProfileSchema.parse(input),hash=runtimeProfileHash(p);
 // Device, source and endpoint must already exist; registration never creates them.
 const owner=(await c.query(`SELECT 1 FROM gowm_device.device d JOIN public.source_registry s ON s.data_scope_key=d.data_scope_key
  JOIN gowm_device.mqtt_endpoint e ON e.endpoint_key=$4
  WHERE d.data_scope_key=$1 AND d.device_id=$2 AND d.enabled AND s.source_key=$3 AND e.enabled`,[p.dataScopeKey,p.deviceId,p.sourceKey,p.endpointKey])).rowCount;
 if(!owner)throw Error('INGEST_RUNTIME_PROFILE_BINDING_UNAVAILABLE');
 await c.query(`INSERT INTO gowm_device.ingest_runtime_profile(data_scope_key,device_id,profile_id,profile_version,profile,content_hash)
  VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING`,[p.dataScopeKey,p.deviceId,p.profileId,p.version,JSON.stringify(p),hash]);
 const stored=await loadRuntimeProfile(c,p.dataScopeKey,p.deviceId,p.profileId,p.version);
 if(runtimeProfileHash(stored)!==hash)throw Error('INGEST_RUNTIME_PROFILE_VERSION_CONFLICT');
 return {profileId:p.profileId,version:p.version,hash};
}
