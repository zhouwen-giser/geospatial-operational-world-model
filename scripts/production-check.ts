import {X509Certificate,createPrivateKey,createPublicKey,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {regularSecret} from '../packages/runtime/src/mqtt-security.js';

export async function checkProductionSecrets(directory:string){
 if(!directory.startsWith('/'))throw Error('GOWM_OPS_SECRET_DIR_ABSOLUTE_REQUIRED');
 const certificate=await regularSecret(resolve(directory,'server-cert.pem'),'SERVER_CERT');
 const key=await regularSecret(resolve(directory,'server-key.pem'),'SERVER_KEY');
 const cert=new X509Certificate(certificate),privateKey=createPrivateKey(key);
 if(!cert.publicKey.export({type:'spki',format:'der'}).equals(createPublicKey(privateKey).export({type:'spki',format:'der'})))throw Error('TLS_CERTIFICATE_KEY_MISMATCH');
 if(Date.parse(cert.validFrom)>Date.now()||Date.parse(cert.validTo)<Date.now())throw Error('TLS_CERTIFICATE_NOT_CURRENT');
 new X509Certificate(await regularSecret(resolve(directory,'ca.pem'),'SERVER_CA'));
 const entries=(await regularSecret(resolve(directory,'mqtt-passwords'),'MQTT_PASSWORDS')).toString('utf8').trim().split(/\r?\n/);
 for(const user of ['gowm_bus','ugv_ingest','ugv_source']){
  if(entries.filter(e=>e.startsWith(user+':')&&e.split(':')[1]?.startsWith('$')).length!==1)throw Error('MQTT_HASHED_USER_REQUIRED: '+user);
 }
 if((await regularSecret(resolve(directory,'bus-password'),'BUS_PASSWORD')).toString('utf8').trim().length<32)throw Error('BUS_PASSWORD_TOO_SHORT');
 return {status:'PASS',certificateSha256:createHash('sha256').update(cert.raw).digest('hex'),validUntil:cert.validTo,
  users:['gowm_bus','ugv_ingest','ugv_source'],credentialAuthentication:'REQUIRES_BROKER_CHECK',remoteDeployment:'NOT_RUN'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--help'))console.log('Read-only production preflight: GOWM_OPS_SECRET_DIR required, checks regular secret files, matching current TLS certificate/key and three hashed MQTT users. Does not initialize or rotate credentials.');
 else {if(!process.env.GOWM_OPS_SECRET_DIR)throw Error('GOWM_OPS_SECRET_DIR required');console.log(JSON.stringify(await checkProductionSecrets(process.env.GOWM_OPS_SECRET_DIR)));}
}
