import pg from "pg";
import { validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";
export function loadOperationalRealityConfig(env:NodeJS.ProcessEnv=process.env){
  const databaseUrl=required(env,"OPERATIONAL_REALITY_DATABASE_URL");const pool=new pg.Pool({connectionString:databaseUrl,application_name:"gowm-operational-reality-provider",max:8});
  return {host:env.OPERATIONAL_REALITY_HOST?.trim()||"0.0.0.0",port:Number(env.OPERATIONAL_REALITY_PORT||8094),transportToken:validateProviderTransportToken(env.PROVIDER_TRANSPORT_SHARED_TOKEN),pool,close:()=>pool.end()};
}
function required(env:NodeJS.ProcessEnv,name:string){const value=env[name]?.trim();if(!value)throw new Error(`${name} is required`);return value;}
