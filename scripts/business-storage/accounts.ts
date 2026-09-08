import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const accounts = [
  { role:'ugv_smpp_app',schema:'ugv_smpp',passwordKey:'SMPP_DB_PASSWORD' },
  { role:'ugv_sdar_app',schema:'ugv_sdar',passwordKey:'SDAR_DB_PASSWORD' }
] as const;

/** Install-time admin operation. Existing managed credentials are checked, never rotated. */
export async function initializeBusinessAccounts(databaseUrl: string, env: NodeJS.ProcessEnv = process.env) {
  const passwords = accounts.map(a => {
    const password = env[a.passwordKey];
    if (!password || !/^[A-Za-z0-9_-]{32,128}$/.test(password)) throw Error(`${a.passwordKey} must be 32-128 URL-safe characters`);
    return password;
  });
  if (passwords[0] === passwords[1]) throw Error('BUSINESS_PASSWORDS_MUST_DIFFER');
  const admin = new pg.Client({connectionString:databaseUrl});
  async function authenticate(role: string,password: string) {
    const url = new URL(databaseUrl); url.username=role; url.password=password;
    const c = new pg.Client({connectionString:url.href,connectionTimeoutMillis:5000});
    try { await c.connect(); await c.query('SELECT 1'); }
    catch { throw Error(`BUSINESS_ACCOUNT_AUTH_FAILED: ${role}; preserve or explicitly reconcile the existing password`); }
    finally { await c.end(); }
  }
  await admin.connect();
  try {
    await admin.query('BEGIN');
    await admin.query('SELECT pg_advisory_xact_lock(718082)');
    for (const [index,a] of accounts.entries()) {
      const marker=`gowm-business-login-v1:${a.schema}`;
      const old=(await admin.query(`SELECT r.*,shobj_description(r.oid,'pg_authid') AS marker FROM pg_roles r WHERE rolname=$1`,[a.role])).rows[0];
      if (old) {
        if (old.marker!==marker || old.rolsuper || old.rolcreatedb || old.rolcreaterole || old.rolreplication || old.rolbypassrls || !old.rolcanlogin)
          throw Error(`BUSINESS_ACCOUNT_CONFLICT: ${a.role}`);
        await authenticate(a.role,passwords[index]!);
      } else {
        // Names are fixed constants. Secret values use a transaction-local setting and SQL format.
        await admin.query("SELECT set_config('gowm.bootstrap_password',$1,true)",[passwords[index]]);
        await admin.query(`DO $$ BEGIN EXECUTE format('CREATE ROLE ${a.role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',current_setting('gowm.bootstrap_password')); END $$`);
        await admin.query(`COMMENT ON ROLE ${a.role} IS '${marker}'`);
      }
      await admin.query(`CREATE SCHEMA IF NOT EXISTS ${a.schema}`);
      await admin.query(`GRANT USAGE ON SCHEMA ${a.schema},public TO ${a.role}`);
      await admin.query(`GRANT gowm_device_reader TO ${a.role}`);
      await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${a.schema} TO ${a.role}`);
      await admin.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${a.schema} TO ${a.role}`);
      await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${a.schema} GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${a.role}`);
      await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${a.schema} GRANT USAGE,SELECT ON SEQUENCES TO ${a.role}`);
      const database=(await admin.query('SELECT current_database() name')).rows[0].name as string;
      await admin.query(`GRANT CONNECT ON DATABASE "${database.replaceAll('"','""')}" TO ${a.role}`);
      await admin.query(`ALTER ROLE ${a.role} IN DATABASE "${database.replaceAll('"','""')}" SET search_path TO ${a.schema},public`);
    }
    await admin.query('COMMIT');
    for (const [index,a] of accounts.entries()) await authenticate(a.role,passwords[index]!);
    return {status:'PASS',accounts:accounts.map(({role,schema})=>({role,schema})),passwordsPreserved:true};
  } catch(error) { await admin.query('ROLLBACK'); throw error; }
  finally { await admin.end(); }
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('Initialize ugv_smpp_app and ugv_sdar_app in the existing GOWM database. Requires GOWM_DATABASE_URL, SMPP_DB_PASSWORD, SDAR_DB_PASSWORD. No native consumer migrations or password rotation.');
  else {
    if (!process.env.GOWM_DATABASE_URL) throw Error('GOWM_DATABASE_URL required');
    console.log(JSON.stringify(await initializeBusinessAccounts(process.env.GOWM_DATABASE_URL)));
  }
}
