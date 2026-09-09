import pg from 'pg';
const args = process.argv.slice(2);
const at = args.indexOf('--scope');
if (at < 0 || !args[at + 1] || args[at + 1].startsWith("--") || args.filter(x=>x==="--scope").length!==1 || args.some((x,i) => !['--scope','--apply'].includes(x) && i !== at + 1)) throw Error('Use --scope <scope> [--apply]; preview is the default');
const scope = args[at + 1], apply = args.includes('--apply');
const connectionString = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw Error('DATABASE_ADMIN_URL or DATABASE_URL is required');
const pool = new pg.Pool({ connectionString, max: 1 });
const client = await pool.connect();
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='30s'");
  await client.query("SET LOCAL lock_timeout='5s'");
  const tasks = (await client.query('SELECT operational_task_id FROM public.operational_task WHERE data_scope_key=$1 ORDER BY operational_task_id', [scope])).rows;
  if (!(await client.query('SELECT 1 FROM public.data_scope WHERE scope_key=$1',[scope])).rowCount) throw Error('Unknown scope');
  let searchRowsAdded=0, externalIdentifiersAdded=0;
  for (const task of apply ? tasks : []) {
    const r = (await client.query('SELECT public.project_operational_task_reference($1,$2) AS result',[scope,task.operational_task_id])).rows[0].result;
    searchRowsAdded += r.searchRowsAdded; externalIdentifiersAdded += r.externalIdentifiersAdded;
  }
  const missing = (await client.query(`SELECT count(*)::int AS count FROM public.operational_task t WHERE t.data_scope_key=$1 AND (
    NOT EXISTS(SELECT 1 FROM public.reference_search_projection s WHERE s.data_scope_key=t.data_scope_key AND s.reference_key=t.reference_key AND s.entity_kind='OPERATIONAL_TASK' AND s.search_kind='REFERENCE_KEY' AND s.normalized_text=t.reference_key)
    OR NOT EXISTS(SELECT 1 FROM public.reference_search_projection s WHERE s.data_scope_key=t.data_scope_key AND s.reference_key=t.reference_key AND s.entity_kind='OPERATIONAL_TASK' AND s.search_kind='EXTERNAL_ID' AND s.normalized_text=public.normalize_reference_text(t.operational_task_id)))`,[scope])).rows[0].count;
  if(apply && missing) throw Error('Reference search verification failed');
  await client.query('COMMIT');
  console.log(JSON.stringify({mode:apply?'APPLIED':'PREVIEW',taskCount:tasks.length,missingTaskCount:missing,searchRowsAdded,externalIdentifiersAdded}));
} catch(error) { await client.query('ROLLBACK'); console.error(JSON.stringify({status:'FAILED',code:typeof error.code==='string'?error.code:'BACKFILL_FAILED'}));process.exitCode=1; }
finally{client.release();await pool.end();}
