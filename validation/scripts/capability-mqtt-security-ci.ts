import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,chmod,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {connectAsync,type MqttClient} from 'mqtt';
import {WorldEventBus} from '../../packages/runtime/src/bus.js';
import {checkProductionSecrets} from '../../scripts/production-check.js';
import {UGV_AUTHORITY_TOPICS} from '../../packages/integrations/ugv-mqtt-ingest-core/src/contracts.js';
import {RESET_ACK_TOPIC} from '../../services/ugv-mqtt-ingest/src/reset-ack.js';

const run=promisify(execFile),dir=await mkdtemp(join(tmpdir(),'gowm-mqtt-acl-test-'));
const container='gowm-capability-mqtt-'+randomUUID().slice(0,8),image='eclipse-mosquitto:2.1.2-alpine@sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408';
const password='test-only-synthetic-credential-0123456789',clients:MqttClient[]=[],bus=new WorldEventBus();let started=false;
try {
 await run(process.execPath,['validation/scripts/capability-production-compose.mjs']);
 await chmod(dir,0o755);
 await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'server-key.pem'),'-out',join(dir,'server-cert.pem'),'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,DNS:mqtt,IP:127.0.0.1']);
 await chmod(join(dir,'server-key.pem'),0o644);await writeFile(join(dir,'ca.pem'),await readFile(join(dir,'server-cert.pem')));await writeFile(join(dir,'bus-password'),password+'\n');
 for(const [i,user]of ['gowm_bus','ugv_ingest','ugv_source'].entries()){
  await run('docker',['run','--rm','-u',`${process.getuid!()}:${process.getgid!()}`,'-v',dir+':/test','--entrypoint','mosquitto_passwd',image,'-b',...(i===0?['-c']:[]),'/test/mqtt-passwords',user,password]);
  // Synthetic test credentials only; make them readable by the test broker UID.
  await chmod(join(dir,'mqtt-passwords'),0o644);
 }
 const preflight=await checkProductionSecrets(dir);assert.equal(preflight.status,'PASS');
 await run('docker',['run','-d','--name',container,'--label','org.gowm.task=capability-mqtt-security','--read-only','--tmpfs','/mosquitto/data:uid=1883,gid=1883',
  '-p','127.0.0.1::1883','-p','127.0.0.1::8883','-v',dir+':/run/gowm-ops:ro',
  '-v',resolve('infrastructure/production/mosquitto.conf')+':/mosquitto/config/mosquitto.conf:ro',
  '-v',resolve('infrastructure/production/mosquitto.acl')+':/mosquitto/config/gowm.acl:ro',image]);started=true;
 const port=async(n:number)=>Number((await run('docker',['port',container,n+'/tcp'])).stdout.trim().split(':').at(-1));
 const plain=await port(1883),tls=await port(8883),ca=await readFile(join(dir,'ca.pem'));
 const connect=(username:string,passwordValue=password,secure=true)=>connectAsync(`${secure?'mqtts':'mqtt'}://127.0.0.1:${secure?tls:plain}`,{protocolVersion:5,
  username,password:passwordValue,reconnectPeriod:0,connectTimeout:1000,ca,rejectUnauthorized:true},false);
 let source:MqttClient|undefined;for(let i=0;i<20;i++){try{source=await connect('ugv_source');break;}catch{await new Promise(r=>setTimeout(r,200));}}
 assert(source,'isolated broker did not start');clients.push(source);
 const ingest=await connect('ugv_ingest');clients.push(ingest);
 const topics=[...UGV_AUTHORITY_TOPICS,RESET_ACK_TOPIC];await ingest.subscribeAsync(topics,{qos:1});
 for(const topic of topics){
  const payload='test-only-route-'+topic;
  const received=new Promise<string>((ok,no)=>{const t=setTimeout(()=>no(Error('MQTT_ALLOWED_TOPIC_TIMEOUT')),2000);ingest.once('message',(actual,b)=>{clearTimeout(t);assert.equal(actual,topic);ok(b.toString());});});
  await source.publishAsync(topic,payload,{qos:1});assert.equal(await received,payload);
 }
 await assert.rejects(connect('ugv_ingest','incorrect-test-only'));
 await assert.rejects(connectAsync(`mqtts://127.0.0.1:${tls}`,{username:'ugv_ingest',password,reconnectPeriod:0,connectTimeout:1000},false));
 await assert.rejects(source.publishAsync('gowm/event/forbidden/UGV','test-only-forbidden',{qos:1}));
 await assert.rejects(ingest.publishAsync('/ugv/gnss','test-only-forbidden',{qos:1}));
 process.env.MQTT_URL=`mqtt://127.0.0.1:${plain}`;process.env.MQTT_USERNAME='gowm_bus';process.env.MQTT_PASSWORD_FILE=join(dir,'bus-password');
 const eventReceived=new Promise<void>((ok,no)=>{const t=setTimeout(()=>no(Error('AUTHENTICATED_BUS_TIMEOUT')),2000);void bus.subscribeEvents(e=>{if(e.eventId==='test-event'){clearTimeout(t);ok();}}).then(()=>bus.publishEvent({eventId:'test-event',eventType:'ObjectMoved',subject:{type:'UGV',id:'test-only'},timestamp:new Date().toISOString(),worldVersion:1,correlationId:'test',causationId:'test',payload:{},schemaVersion:'1.0'})).catch(no);});
 await eventReceived;
 const report={status:'PASS',checks:['current_certificate_key_preflight','authenticated_tls_7_streams_and_reset_ack','bad_credentials_and_untrusted_tls_rejected',
  'ingest_and_source_write_acl_isolation','world_event_bus_file_credentials'],credentials:'SYNTHETIC_TEST_ONLY',remoteDeployment:'NOT_RUN'};
 await mkdir('reports/capability-completion-2026-10-12',{recursive:true});await writeFile('reports/capability-completion-2026-10-12/mqtt-security.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await bus.drain();for(const client of clients)await client.endAsync(true);if(started)await run('docker',['rm','--force','--volumes',container]);await rm(dir,{recursive:true,force:true});}
