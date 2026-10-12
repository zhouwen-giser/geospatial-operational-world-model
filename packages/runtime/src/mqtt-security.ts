import {lstat,readFile} from 'node:fs/promises';
import type {IClientOptions} from 'mqtt';

export async function regularSecret(path:string,label:string):Promise<Buffer>{
 if(!path.startsWith('/'))throw Error(label+'_ABSOLUTE_FILE_REQUIRED');
 const s=await lstat(path);
 if(!s.isFile()||s.isSymbolicLink()||s.size>1048576)throw Error(label+'_REGULAR_FILE_REQUIRED');
 return readFile(path);
}

/** Optional bus credentials. Never disable TLS verification or embed secrets in URLs. */
export async function mqttSecurity(url:string,env:NodeJS.ProcessEnv=process.env):Promise<IClientOptions>{
 const parsed=new URL(url);
 if(!['mqtt:','mqtts:','ws:','wss:'].includes(parsed.protocol)||parsed.username||parsed.password)throw Error('MQTT_ENDPOINT_INVALID');
 const username=env.MQTT_USERNAME?.trim(),passwordFile=env.MQTT_PASSWORD_FILE?.trim();
 if(Boolean(username)!==Boolean(passwordFile))throw Error('MQTT_CREDENTIAL_PAIR_REQUIRED');
 const result:IClientOptions={rejectUnauthorized:true};
 if(username&&passwordFile){result.username=username;result.password=(await regularSecret(passwordFile,'MQTT_PASSWORD')).toString('utf8').trimEnd();}
 if(env.MQTT_CA_FILE)result.ca=await regularSecret(env.MQTT_CA_FILE,'MQTT_CA');
 if(Boolean(env.MQTT_CERT_FILE)!==Boolean(env.MQTT_KEY_FILE))throw Error('MQTT_CLIENT_CERTIFICATE_PAIR_REQUIRED');
 if(env.MQTT_CERT_FILE&&env.MQTT_KEY_FILE){result.cert=await regularSecret(env.MQTT_CERT_FILE,'MQTT_CERT');result.key=await regularSecret(env.MQTT_KEY_FILE,'MQTT_KEY');}
 if((result.ca||result.cert)&&!['mqtts:','wss:'].includes(parsed.protocol))throw Error('MQTT_TLS_ENDPOINT_REQUIRED');
 return result;
}
