import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const lock=JSON.parse(await readFile('database/capability-completion-freeze-lock.json','utf8'));
const migrations=(await readdir('database/migrations')).filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=89).sort();
if(migrations.length!==89||JSON.stringify(lock.migrations.map(e=>e.path))!==JSON.stringify(migrations.map(f=>'database/migrations/'+f)))throw Error('CAPABILITY_BASELINE_FILE_SET_CHANGED');
for(const entry of [...lock.migrations,...lock.legacyContracts]){
 const digest=createHash('sha256').update(await readFile(entry.path)).digest('hex');
 if(digest!==entry.sha256)throw Error('CAPABILITY_BASELINE_BYTES_CHANGED: '+entry.path);
}
console.log('PASS: delivered 001–089 and frozen historical consumer contracts retain original bytes');
