import pg from 'pg';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBusinessDeviceContext } from '../../packages/integrations/device-business-storage/src/context.js';

/** Read-only deployment gate using the actual runtime login, never an administrator SET ROLE. */
export async function verifyBusinessRuntime(databaseUrl:string,env:NodeJS.ProcessEnv=process.env) {
  const mode=env.GOWM_BUSINESS_INSTALL_MODE??'storage';
  if(!['ingest','storage','ready'].includes(mode))throw Error('BUSINESS_INSTALL_MODE_INVALID');
  const smpp=[env.SMPP_SERVICE_KEY,env.UGV_PROVIDER_ID,env.UGV_RESOURCE_ID],sdar=[env.SDAR_SERVICE_KEY,env.SDAR_MCP_SERVER_ID];
  const present=(v:string|undefined)=>Boolean(v?.trim());
  if((smpp.some(present)&&!smpp.every(present))||(sdar.some(present)&&(!sdar.every(present)||!smpp.every(present)))||
    (present(env.SDAR_AGENT_PROFILE_ID)&&!sdar.every(present))||(mode==='ready'&&(!smpp.every(present)||!sdar.every(present))))throw Error('BUSINESS_DEVICE_CONFIG_INCOMPLETE');
  const checks=[];let expectedDevice:string|undefined;
  for(const [role,schema,password] of [['ugv_smpp_app','ugv_smpp',env.SMPP_DB_PASSWORD],['ugv_sdar_app','ugv_sdar',env.SDAR_DB_PASSWORD]] as const){
    if(!password)throw Error('BUSINESS_LOGIN_PASSWORD_REQUIRED: '+role);
    const url=new URL(databaseUrl);url.username=role;url.password=password;
    const c=new pg.Client({connectionString:url.href,connectionTimeoutMillis:5000});
    try{
      await c.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const native=mode==='ingest'?'DISABLED':(await c.query("SELECT to_regclass($1) IS NOT NULL AND has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE') AS ready",[`${schema}.${schema==='ugv_smpp'?'provider_task':'agent_task'}`])).rows[0].ready?'READY':'MISSING';
      if(native==='MISSING')throw Error('NATIVE_STORAGE_NOT_READY: '+schema);
      const configured=smpp.every(present)&&(schema==='ugv_smpp'||sdar.every(present));
      let deviceId:string|undefined;
      if(configured){
        const context=await resolveBusinessDeviceContext(c as unknown as pg.PoolClient,{scope:env.UGV_DATA_SCOPE_KEY??'default',smppServiceKey:env.SMPP_SERVICE_KEY!,
          providerId:env.UGV_PROVIDER_ID!,resourceId:env.UGV_RESOURCE_ID!,...(sdar.every(present)?{sdarServiceKey:env.SDAR_SERVICE_KEY!,sdarMcpServerId:env.SDAR_MCP_SERVER_ID!}:{}),
          ...(env.SDAR_AGENT_PROFILE_ID?{agentProfileId:env.SDAR_AGENT_PROFILE_ID}:{})},'verify');
        deviceId=context.deviceId;
        if(expectedDevice && expectedDevice!==deviceId)throw Error('BUSINESS_DEVICE_BINDING_MISMATCH');
        expectedDevice=deviceId;
        if(mode!=='ingest')await c.query("SELECT gowm_business_api.read('tasks',jsonb_build_object('deviceId',$1::text,'limit',1))",[deviceId]);
      }
      await c.query('COMMIT');checks.push({role,nativeStorage:native,binding:configured?'READY':'NOT_CONFIGURED',...(deviceId?{deviceId}:{})});
    }catch(error){await c.query('ROLLBACK').catch(()=>{});throw Object.assign(Error('BUSINESS_RUNTIME_VERIFY_FAILED: '+role+'; '+(error instanceof Error?error.message:'verification failed')),{code:(error as {code?:string}).code});}
    finally{await c.end().catch(()=>{});}
  }
  return {status:'PASS',mode,businessReady:checks.every(c=>c.binding==='READY'&&c.nativeStorage==='READY'),checks};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.env.GOWM_DATABASE_URL)throw Error('GOWM_DATABASE_URL required');
  console.log(JSON.stringify(await verifyBusinessRuntime(process.env.GOWM_DATABASE_URL)));
}
