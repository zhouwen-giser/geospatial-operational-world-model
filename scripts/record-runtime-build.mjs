import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const release=JSON.parse(await readFile('scripts/history-release-manifest.json','utf8'));
const modules=[];
for(const entry of release.runtime){
  const actual=hash(await readFile(entry.source));
  if(actual!==entry.sha256)throw Error('BUILD_SOURCE_MANIFEST_MISMATCH: '+entry.source);
  modules.push({source:entry.source,sourceSha256:actual,compiled:entry.compiled,compiledSha256:hash(await readFile(entry.compiled))});
}
await writeFile('dist/runtime-build-identity.json',JSON.stringify({formatVersion:1,migrationHead:release.migrationHead,modules},null,2)+'\n');
console.log(`PASS: recorded ${modules.length} compiled modules against the release source manifest`);
