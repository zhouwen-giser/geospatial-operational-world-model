import { buildOperationalRealityApp } from "./app.js";import { loadOperationalRealityConfig } from "./config.js";import { createOperationalRealityProvider } from "./provider.js";
const config=loadOperationalRealityConfig();const provider=createOperationalRealityProvider({pool:config.pool});const app=buildOperationalRealityApp(provider,config.transportToken);
await app.listen({host:config.host,port:config.port});console.info(JSON.stringify({message:"Operational Reality Provider listening",port:config.port,providerId:provider.runtime.manifest.provider.providerId}));
for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{void Promise.allSettled([app.close(),config.close()]).then(()=>{process.exitCode=0;});});
export * from "./app.js";export * from "./config.js";export * from "./provider.js";export * from "./repository.js";export * from "./schemas.js";
