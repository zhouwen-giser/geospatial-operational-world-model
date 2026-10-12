import pg from 'pg';
import { install, verify } from './installer.js';
const mode=process.env.GOWM_BUSINESS_INSTALL_MODE??'storage';
if (!['ingest','storage','ready'].includes(mode)) throw Error('BUSINESS_INSTALL_MODE_INVALID');
if (!process.env.GOWM_DATABASE_URL) throw Error('GOWM_DATABASE_URL required');
if (mode==='ingest') console.log(JSON.stringify({status:'NOT_CONFIGURED',nativeStorage:'DISABLED'}));
else {
  const c=new pg.Client({connectionString:process.env.GOWM_DATABASE_URL});
  await c.connect();
  try {
    const ext=(await c.query("SELECT e.extversion,n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'")).rows[0];
    if (ext && ext.nspname!=='public') throw Error('EXTENSION_NAMESPACE_UNSUPPORTED');
    if (!ext) {
      if (process.env.GOWM_BOOTSTRAP_CREATE_VECTOR!=='true') throw Error('VECTOR_ADMIN_INSTALL_REQUIRED: use the explicit fresh bootstrap step');
      await c.query('CREATE EXTENSION vector WITH SCHEMA public');
    }
    await install(c as unknown as pg.PoolClient);
    const extensions=(await c.query("SELECT e.extname,e.extversion,n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'")).rows;
    if((await c.query("SELECT public.vector_dims('[1,2,3]'::public.vector) n")).rows[0].n!==3)throw Error('VECTOR_FEATURE_CHECK_FAILED');
    console.log(JSON.stringify({...await verify(c as unknown as pg.PoolClient),extensions}));
  } finally {await c.end();}
}
