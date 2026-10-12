import {describe,it,expect} from 'vitest';
import {mkdtemp,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {request} from 'node:https';
import {once} from 'node:events';
import {createTlsEdge} from '../../services/tls-edge/src/server.js';
import {mqttSecurity} from '../../packages/runtime/src/mqtt-security.js';
import {checkProductionSecrets} from '../../scripts/production-check.js';

describe('production boundary',()=>{
 it('streams HTTPS through the fixed Gateway, preserves authorization and rejects untrusted TLS and oversized input',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gowm-edge-test-')),run=promisify(execFile);
  const upstream=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({authorization:req.headers.authorization??null,forwarded:req.headers['x-forwarded-for']??null,path:req.url}));});
  let edge:ReturnType<typeof createTlsEdge>|undefined,mutual:ReturnType<typeof createTlsEdge>|undefined;
  try {
   await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'server-key.pem'),'-out',join(dir,'server-cert.pem'),'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
   const cert=await readFile(join(dir,'server-cert.pem')),key=await readFile(join(dir,'server-key.pem'));
   await writeFile(join(dir,'ca.pem'),cert);await writeFile(join(dir,'mqtt-passwords'),'gowm_bus:$7$test\nugv_ingest:$7$test\nugv_source:$7$test\n');await writeFile(join(dir,'bus-password'),'test-only-'.repeat(4));
   expect((await checkProductionSecrets(dir)).status).toBe('PASS');
   upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
   edge=createTlsEdge({cert,key},'http://127.0.0.1:'+(upstream.address() as {port:number}).port,1024);edge.listen(0,'127.0.0.1');await once(edge,'listening');
   const get=(port:number,opts:Record<string,unknown>={})=>new Promise<{status:number;body:string}>((ok,no)=>{
    const r=request({hostname:'127.0.0.1',servername:'localhost',port,path:'/v1/catalog',ca:cert,...opts},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>ok({status:res.statusCode!,body}));});r.on('error',no);r.end();
   });
   const port=(edge.address() as {port:number}).port;
   const response=await get(port,{headers:{authorization:'Bearer test-token','x-forwarded-for':'untrusted'}});
   expect(JSON.parse(response.body)).toEqual({authorization:'Bearer test-token',forwarded:null,path:'/v1/catalog'});
   await expect(get(port,{ca:undefined})).rejects.toThrow();
   expect((await get(port,{method:'POST',headers:{'content-length':'4096'}})).status).toBe(413);
   mutual=createTlsEdge({cert,key,ca:cert,requestCert:true,rejectUnauthorized:true},'http://127.0.0.1:'+(upstream.address() as {port:number}).port);mutual.listen(0,'127.0.0.1');await once(mutual,'listening');
   await expect(get((mutual.address() as {port:number}).port)).rejects.toThrow();
   expect((await get((mutual.address() as {port:number}).port,{cert,key})).status).toBe(200);
  }finally{edge?.closeAllConnections();mutual?.closeAllConnections();edge?.close();mutual?.close();upstream.closeAllConnections();upstream.close();await rm(dir,{recursive:true,force:true});}
 },15000);
 it('loads MQTT credentials only from regular files and keeps TLS verification enabled',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gowm-mqtt-secret-'));try{
   const file=join(dir,'password');await writeFile(file,'test-only-secret\n');await symlink(file,join(dir,'link'));
   expect(await mqttSecurity('mqtt://localhost',{})).toEqual({rejectUnauthorized:true});
   const c=await mqttSecurity('mqtts://localhost',{MQTT_USERNAME:'gowm_bus',MQTT_PASSWORD_FILE:file});expect(c.password).toBe('test-only-secret');expect(c.rejectUnauthorized).toBe(true);
   await expect(mqttSecurity('mqtts://localhost',{MQTT_USERNAME:'gowm_bus'})).rejects.toThrow('PAIR_REQUIRED');
   await expect(mqttSecurity('mqtts://user:secret@localhost',{})).rejects.toThrow('ENDPOINT_INVALID');
   await expect(mqttSecurity('mqtts://localhost',{MQTT_USERNAME:'gowm_bus',MQTT_PASSWORD_FILE:join(dir,'link')})).rejects.toThrow('REGULAR_FILE');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
