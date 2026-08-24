import Fastify,{type FastifyInstance} from "fastify";
import type { PlatformError,ProviderExecutionRequest } from "../../../../packages/platform/contract-runtime/src/index.js";
import { createProviderTransportAuthenticator,newOpaqueId,ProviderProtocolError } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { OperationalRealityProvider } from "./provider.js";

export function buildOperationalRealityApp(provider:OperationalRealityProvider,transportToken:string):FastifyInstance {
  const app=Fastify({logger:false,bodyLimit:1048576});const authenticate=createProviderTransportAuthenticator(transportToken);
  app.addHook("onRequest",async(request)=>{if(request.method==="POST"&&request.url.startsWith("/v1/operations/"))authenticate(request.headers.authorization);});
  app.get("/v1/manifest",async()=>provider.runtime.manifest);app.get("/health/live",async()=>provider.runtime.health());
  app.get("/health/ready",async(_request,reply)=>{const ready=await provider.repository.readiness();return reply.code(ready.ready?200:503).send(ready);});
  app.get("/v1/jobs/:jobId",async(request,reply)=>reply.code(404).send({error:"JOB_NOT_FOUND",jobId:(request.params as {jobId:string}).jobId}));
  app.post("/v1/operations/*",async(request,reply)=>{const suffix=(request.params as {"*":string})["*"];if(!suffix.endsWith(":execute"))throw new ProviderProtocolError("OPERATION_NOT_FOUND","operation route is not registered");const id=suffix.slice(0,-8);const body=request.body as ProviderExecutionRequest;if(body?.operation?.operationId!==id)throw new ProviderProtocolError("SCHEMA_MISMATCH","route operation does not match request operation");return reply.send(await provider.runtime.execute(body));});
  app.setErrorHandler((error,request,reply)=>{const mapped=error instanceof ProviderProtocolError?error:new ProviderProtocolError("INTERNAL_PROVIDER_ERROR","operational reality execution failed",{cause:error});const payload:PlatformError={schemaVersion:"1.0",requestId:newOpaqueId("operational_request"),error:{code:mapped.code,message:mapped.message,retryable:mapped.retryable,stage:"PROVIDER_EXECUTION",providerId:"gowm.operational-reality"}};return reply.code(mapped.httpStatus).send(payload);});
  return app;
}
