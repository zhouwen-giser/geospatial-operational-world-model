import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const lock = JSON.parse(await readFile('database/functional-repair-freeze-lock.json','utf8'));
const files = (await readdir('database/migrations')).filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=86).sort();
if (lock.migrationHead!==86 || files.length!==86 || JSON.stringify(files)!==JSON.stringify(Object.keys(lock.migrations))) throw Error('FUNCTIONAL_BASELINE_FILE_SET_CHANGED');
for (const file of files) {
  const hash=createHash('sha256').update(await readFile(`database/migrations/${file}`)).digest('hex');
  if (hash!==lock.migrations[file]) throw Error(`FUNCTIONAL_BASELINE_BYTES_CHANGED: ${file}`);
}
for (const entry of lock.nativeSql) {
  const hash=createHash('sha256').update(await readFile(entry.path)).digest('hex');
  if(hash!==entry.sha256) throw Error(`NATIVE_BASELINE_BYTES_CHANGED: ${entry.path}`);
}
console.log(`PASS: retained-package baseline migrations 001–086 and ${lock.nativeSql.length} native SQL files unchanged`);
