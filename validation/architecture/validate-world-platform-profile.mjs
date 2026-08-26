import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const compose=JSON.parse(execFileSync('docker',['compose','--env-file','.env.world-platform.example','-f','docker-compose.yml','-f','docker-compose.world-platform.yml','--profile','world-platform','config','--format','json'],{encoding:'utf8',maxBuffer:8*1024*1024}));
const active=Object.entries(compose.services).filter(([,s])=>!s.profiles?.length||s.profiles.includes('world-platform'));
const exposed=active.filter(([,s])=>s.ports?.length).map(([n])=>n);
const providers=active.filter(([n])=>n.includes('provider'));
const checks={
 onlyGatewayPublished:exposed.length===1&&exposed[0]==='world-capability-gateway',
 internalDefaultNetwork:compose.networks.default.internal===true,
 gatewaySeparateEdge:Object.hasOwn(compose.services['world-capability-gateway'].networks,'world-edge'),
 providerPortsAbsent:providers.every(([,s])=>!s.ports?.length),
 providerNetworkIsolated:providers.every(([,s])=>Object.keys(s.networks).join(',')==='default'),
 requiredProcesses:providers.length===13,
 gatewayNoProviderHealthDependency:Object.keys(compose.services['world-capability-gateway'].depends_on).every((n)=>!n.includes('provider')),
 privilegedBootstrapSeparate:!Object.keys(compose.services['world-capability-gateway'].environment).some((k)=>/REGISTRY_DATABASE_URL|POSTGRES_PASSWORD/u.test(k)),
 oneConsumerEndpoint:(await readFile('config/consumers/wsgs.env.example','utf8')).split('\n').filter((l)=>l&&!l.startsWith('#')).every((l)=>l.startsWith('GOWM_GATEWAY_BASE_URL='))
};
const report={status:Object.values(checks).every(Boolean)?'PASS':'FAIL',checks,activeServices:active.map(([n])=>n),publishedServices:exposed};
await writeFile('reports/gowm-v0.6.2/world-platform-profile-report.json',JSON.stringify(report,null,2)+'\n');
if(report.status!=='PASS')throw new Error(JSON.stringify(report));
process.stdout.write('WORLD_PLATFORM_PROFILE_PASS '+Object.keys(checks).length+' checks\n');
