import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile),dir=await mkdtemp(join(tmpdir(),'gowm-production-compose-'));
try {
 const file=join(dir,'.env'),runtime=join(dir,'runtime'),secrets=join(dir,'secrets');
 await mkdir(secrets);await writeFile(file,await readFile('.env.example'));
 await run('bash',['-c','source "$1"; runtime_dir="$2"; init_env','test',resolve('scripts/dev-deploy.sh'),runtime],{env:{...process.env,GOWM_DEV_ENV_FILE:file}});
 const args=['compose','--env-file',file,'--profile','foundation-admin','--profile','world-platform','--profile','ugv-mqtt','-f','docker-compose.yml','-f','docker-compose.world-platform.yml'];
 const env={...process.env,GOWM_OPS_SECRET_DIR:secrets};
 const render=async(extra=[])=>JSON.parse((await run('docker',[...args,...extra,'config','--format','json'],{env,maxBuffer:4*1024*1024})).stdout);
 const base=await render(),production=await render(['-f','docker-compose.production.yml']);
 const published=Object.entries(production.services).flatMap(([name,s])=>(s.ports??[]).map(p=>({name,target:p.target,published:p.published,host:p.host_ip})));
 assert.deepEqual(published.sort((a,b)=>a.name.localeCompare(b.name)),[
  {name:'mqtt',target:8883,published:'8883',host:'127.0.0.1'},
  {name:'tls-edge',target:8443,published:'8443',host:'127.0.0.1'}
 ]);
 assert.deepEqual(production.volumes,base.volumes,'overlay must preserve volume identities');
 assert.deepEqual(production.services.postgres.volumes,base.services.postgres.volumes);
 assert(base.services['world-capability-gateway'].environment.GATEWAY_AUTH_SHARED_TOKEN.length>=32);
 assert.equal(production.services['world-capability-gateway'].environment.GATEWAY_AUTH_SHARED_TOKEN,base.services['world-capability-gateway'].environment.GATEWAY_AUTH_SHARED_TOKEN);
 for(const name of ['world-api','observation-ingest','projection-worker','world-platform-projection-worker']){
  const s=production.services[name];assert.equal(s.environment.MQTT_USERNAME,'gowm_bus');
  assert.equal(s.environment.MQTT_PASSWORD_FILE,'/run/gowm-ops/bus-password');
  const mounts=s.volumes.filter(v=>v.target.startsWith('/run/gowm-ops'));
  assert.equal(mounts.length,1);assert.equal(mounts[0].source,join(secrets,'bus-password'));assert.equal(mounts[0].read_only,true);
 }
 const ingress=production.services['tls-edge'];assert.equal(ingress.environment.TLS_GATEWAY_URL,'http://world-capability-gateway:8090');
 assert.equal(ingress.read_only,true);assert.deepEqual(ingress.cap_drop,['ALL']);
 assert(!ingress.volumes.some(v=>v.target.includes('password')));
 assert(production.services['ugv-mqtt-ingest'].volumes.some(v=>v.source===join(secrets,'ugv')&&v.read_only));
 assert('ugv-source-egress'in production.services['ugv-mqtt-ingest'].networks);
 assert.notEqual(production.networks['ugv-source-egress'].internal,true,'existing external device broker needs an outbound route');
 for(const [name,s]of Object.entries(production.services))if(name!=='ugv-mqtt-ingest')assert(!('ugv-source-egress'in(s.networks??{})));
 for(const [name,s]of Object.entries(production.services))if(!['mqtt','tls-edge'].includes(name))assert(!('world-edge'in(s.networks??{})),name+' must remain internal');
 const report={status:'PASS',gate:'EFFECTIVE_PRODUCTION_COMPOSE',publishedPorts:published,volumeIdentitiesPreserved:true,credentialMountIsolation:true,deviceBrokerEgress:'SEPARATE_NETWORK_NO_PUBLISHED_PORT',automaticInitialization:'NOT_EXECUTED'};
 await mkdir('reports/capability-completion-2026-10-12',{recursive:true});await writeFile('reports/capability-completion-2026-10-12/production-compose.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await rm(dir,{recursive:true,force:true});}
