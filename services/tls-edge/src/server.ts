import {createServer,type ServerOptions} from 'node:https';
import {request as httpRequest,type IncomingMessage,type ServerResponse} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {regularSecret} from '../../../packages/runtime/src/mqtt-security.js';

const hop=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
function filtered(headers:IncomingMessage['headers']){
 const skip=new Set([...hop,...String(headers.connection??'').split(',').map(v=>v.trim().toLowerCase())]);
 return Object.fromEntries(Object.entries(headers).filter(([k])=>!skip.has(k)&&!k.startsWith('x-forwarded-')&&k!=='forwarded'));
}
export function createTlsEdge(tls:ServerOptions,upstreamUrl:string,maximumBodyBytes=8388608){
 const upstream=new URL(upstreamUrl);
 if(!['http:','https:'].includes(upstream.protocol)||upstream.username||upstream.password||upstream.pathname!=='/'||upstream.search||upstream.hash)throw Error('TLS_EDGE_UPSTREAM_INVALID');
 let active=0;
 const server=createServer({...tls,minVersion:'TLSv1.2',maxHeaderSize:16384},(req,res)=>{
  res.setHeader('strict-transport-security','max-age=31536000');
  if(req.url==='/health/live'){res.end(JSON.stringify({service:'gowm-tls-edge',status:'ok'}));return;}
  if(active>=128){res.writeHead(503);res.end('EDGE_CAPACITY_EXCEEDED');return;}
  if(!req.url?.startsWith('/')||Number(req.headers['content-length']??0)>maximumBodyBytes){res.writeHead(413);res.end('EDGE_REQUEST_REJECTED');req.resume();return;}
  active++;let finished=false,bodyBytes=0;
  const complete=()=>{if(!finished){finished=true;active--;}};
  const fail=(status:number,code:string)=>{if(!res.headersSent){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:code}));}else res.destroy();};
  const headers={...filtered(req.headers),host:upstream.host,'x-forwarded-proto':'https'};
  const out=(upstream.protocol==='https:'?httpsRequest:httpRequest)({hostname:upstream.hostname,port:upstream.port||undefined,
   method:req.method??'GET',path:req.url,headers,timeout:65000,rejectUnauthorized:true},response=>{
   res.writeHead(response.statusCode??502,{...filtered(response.headers),'strict-transport-security':'max-age=31536000'});
   response.on('error',()=>res.destroy());response.pipe(res);
  });
  out.on('error',()=>fail(502,'EDGE_UPSTREAM_UNAVAILABLE'));
  out.on('timeout',()=>{fail(504,'EDGE_UPSTREAM_TIMEOUT');out.destroy();});
  req.on('data',(chunk:Buffer)=>{bodyBytes+=chunk.length;if(bodyBytes>maximumBodyBytes){req.unpipe(out);req.resume();fail(413,'EDGE_BODY_LIMIT');out.destroy();}});
  req.on('aborted',()=>out.destroy());
  res.on('close',()=>{complete();out.destroy();});res.on('finish',complete);
  req.pipe(out);
 });
 server.headersTimeout=15000;server.requestTimeout=300000;server.keepAliveTimeout=5000;
 return server;
}

export async function runTlsEdge(env:NodeJS.ProcessEnv=process.env){
 if(!env.TLS_CERT_FILE||!env.TLS_KEY_FILE)throw Error('TLS_CERT_FILE_AND_TLS_KEY_FILE_REQUIRED');
 const options:ServerOptions={cert:await regularSecret(env.TLS_CERT_FILE,'TLS_CERT'),key:await regularSecret(env.TLS_KEY_FILE,'TLS_KEY')};
 if(env.TLS_CLIENT_CA_FILE){options.ca=await regularSecret(env.TLS_CLIENT_CA_FILE,'TLS_CLIENT_CA');options.requestCert=true;options.rejectUnauthorized=true;}
 const port=Number(env.TLS_EDGE_PORT??8443);if(!Number.isInteger(port)||port<1||port>65535)throw Error('TLS_EDGE_PORT_INVALID');
 const server=createTlsEdge(options,env.TLS_GATEWAY_URL??'http://world-capability-gateway:8090');
 await new Promise<void>((ok,no)=>{server.once('error',no);server.listen(port,'0.0.0.0',ok);});
 const stop=()=>{server.close();server.closeIdleConnections();const timer=setTimeout(()=>server.closeAllConnections(),30000);timer.unref();};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--help'))console.log('Optional HTTPS Gateway edge. TLS_CERT_FILE/TLS_KEY_FILE required; TLS_CLIENT_CA_FILE enables mandatory mTLS. Existing Gateway authorization remains required.');
 else await runTlsEdge();
}
