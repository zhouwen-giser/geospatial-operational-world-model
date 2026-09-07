import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const args = process.argv.slice(2);
let scope: string | undefined, referencesPath: string | undefined, apply = false, fingerprintOnly = false;
for (let index=0; index<args.length; index++) {
  switch (args[index]) {
    case "--scope": scope=args[++index]; break;
    case "--references": referencesPath=args[++index]; break;
    case "--apply": apply=true; break;
    case "--show-db-fingerprint": fingerprintOnly=true; break;
    default: throw new Error("Usage: --scope <scope> --references <JSON string-array file> [--apply] | --show-db-fingerprint");
  }
}
if (fingerprintOnly && apply) throw new Error("fingerprint is read-only; do not combine with --apply");
if (!fingerprintOnly && (!scope?.trim() || !referencesPath)) throw new Error("explicit scope and reference-list file required");
const references: unknown = referencesPath ? JSON.parse(await readFile(referencesPath,"utf8")) : [];
if (!Array.isArray(references) || references.some(value=>typeof value!=="string" || !/^wrf_[a-f0-9]{32}$/.test(value))) {
  throw new Error("reference list must contain only opaque GOWM reference IDs");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; use the reviewed operator connection");
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
try {
  const client = await pool.connect();
  try {
    await client.query(apply ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SET LOCAL lock_timeout='2s'");
    const identity=(await client.query("SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,pg_postmaster_start_time()::text AS started")).rows[0];
    const fingerprint=`sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
    if (fingerprintOnly) {
      await client.query("COMMIT"); console.log(JSON.stringify({mode:"READ_ONLY",databaseFingerprint:fingerprint}));
    } else {
      const plan=(await client.query("SELECT public.plan_world_object_catalog_backfill($1,$2::text[]) AS plan",[scope,references])).rows[0].plan;
      if (!apply) {
        await client.query("COMMIT");
        console.log(JSON.stringify({mode:"DRY_RUN",databaseFingerprint:fingerprint,scope,...plan}));
      } else {
        if (process.env.GOWM_REFERENCE_CATALOG_ALLOW_DB_MUTATION!=="YES" ||
            process.env.GOWM_REFERENCE_CATALOG_EXPECTED_DB_FINGERPRINT!==fingerprint ||
            process.env.GOWM_REFERENCE_CATALOG_EXPECTED_PLAN_HASH!==plan.planHash) {
          throw new Error("apply requires explicit YES, exact instance fingerprint and reviewed dry-run plan hash");
        }
        await client.query("SELECT set_config('gowm.reference_catalog_allow_apply','YES',true)");
        const result=(await client.query("SELECT public.apply_world_object_catalog_backfill($1,$2::text[],$3) AS result",
          [scope,references,plan.planHash])).rows[0].result;
        await client.query("COMMIT");
        console.log(JSON.stringify({mode:"APPLIED",databaseFingerprint:fingerprint,scope,...result}));
      }
    }
  } catch (error) { await client.query("ROLLBACK").catch(()=>undefined); throw error; }
  finally { client.release(); }
} finally { await pool.end(); }
