import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {semanticSourceFingerprint} from '../../packages/platform/semantic-conformance/src/index.ts';
const root=resolve('.'), reportRoot=process.env.GOWM_REPORT_DIRECTORY?.trim()||'reports/gowm-v0.6.2';
const v07=reportRoot.replaceAll('\\','/').includes('reports/gowm-v0.7/'), dir=`${reportRoot}/regression`;
const npmEntrypoint=process.env.npm_execpath;
if(!npmEntrypoint)throw new Error('npm_execpath is required');
await mkdir(dir,{recursive:true});
const sourceDigest=await semanticSourceFingerprint(root), commands=[];
const suite=[
 ['types-contracts',['run','check']],['sql-ast',['run','verify:sql']],
 ['vitest',['test','--','--reporter=default','--reporter=json',`--outputFile=${dir}/vitest.json`]],
 ['stas',['--prefix','services/stas','test']],['build',['run','build']],
 ['legacy-contracts',['run','validate:stable-contracts']],['boundaries',['run','validate:boundaries']],
 ['profile',['run','validate:world-platform-profile']],['materializer',['run','validate:semantic-materializer']],
 ['semantic-catalog',['run','validate:semantic-catalog']],['registry',['run','validate:world-platform-registry']],
 [(reportRoot.endsWith('gowm-v0.6.3')||v07)?'consumer-contracts':'wsgs-lock',['run',(reportRoot.endsWith('gowm-v0.6.3')||v07)?'validate:consumer-contracts':'validate:wsgs-lock']],['provider-conformance',['run','validate:provider-conformance']]
];
if(v07)suite.splice(8,0,['materializer-write',['run','validate:semantic-materializer','--','--write']]);
for(const [id,args] of suite){
 const result=spawnSync(process.execPath,[npmEntrypoint,...args],{encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,GOWM_REPORT_DIRECTORY:reportRoot,GOWM_CONFORMANCE_OUTPUT_DIRECTORY:resolve(`${reportRoot}/provider-conformance`)}});
 await writeFile(`${dir}/${id}.log`,`${result.stdout??''}\n${result.stderr??''}`);
 commands.push({id,command:['npm',...args],status:result.status===0?'PASS':'FAIL',exitCode:result.status,log:`${dir}/${id}.log`});
 process.stdout.write(`${id}: ${commands.at(-1).status}\n`);
 if(result.status!==0)break;
}
const sourceAfter=await semanticSourceFingerprint(root);
const status=commands.length===suite.length&&commands.every(c=>c.status==='PASS')&&sourceDigest===sourceAfter?'PASS':'FAIL';
await writeFile(`${dir}/report.json`,JSON.stringify({status,sourceDigest,sourceAfter,commands},null,2)+'\n');
if(status!=='PASS')process.exitCode=1;
