import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,readFile,rm,stat,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { describe,it,expect } from 'vitest';

describe('installation business credentials',()=>{
  it('generates separate private passwords once and preserves source configuration',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'gowm-bootstrap-'));
    try {
      const envFile=join(dir,'.env'),runtime=join(dir,'runtime');
      const source=(await readFile('.env.example','utf8')).replace('UGV_DATA_SCOPE_KEY=airport-sim-ugv-01','UGV_DATA_SCOPE_KEY=default')
        .replace('UGV_MQTT_URL=mqtt://replace-with-source-broker:1883','UGV_MQTT_URL=mqtt://existing-broker:1883');
      await writeFile(envFile,source);
      const invoke=()=>promisify(execFile)('bash',['-c','source "$1"; runtime_dir="$2"; init_env','bootstrap',resolve('scripts/dev-deploy.sh'),runtime],{env:{...process.env,GOWM_DEV_ENV_FILE:envFile}});
      await invoke();
      const first=await readFile(envFile,'utf8');
      const creds=await readFile(join(runtime,'business-connections.env'),'utf8');
      const password=(key:string)=>new RegExp(`^${key}=(.*)$`,'m').exec(first)![1]!;
      expect(password('SMPP_DB_PASSWORD')).toMatch(/^[a-f0-9]{64}$/);
      expect(password('SDAR_DB_PASSWORD')).not.toBe(password('SMPP_DB_PASSWORD'));
      expect(creds).toContain('SMPP_DB_USER=ugv_smpp_app');
      expect(creds).toContain('SDAR_DB_USER=ugv_sdar_app');
      expect(first).toContain('UGV_DATA_SCOPE_KEY=default');
      expect(first).toContain('UGV_MQTT_URL=mqtt://existing-broker:1883');
      expect((await stat(join(runtime,'business-connections.env'))).mode&0o777).toBe(0o600);
      await invoke();
      expect(await readFile(envFile,'utf8')).toBe(first);
      expect(await readFile(join(runtime,'business-connections.env'),'utf8')).toBe(creds);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});
