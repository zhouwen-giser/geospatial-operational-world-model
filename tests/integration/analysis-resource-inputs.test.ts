import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.GOWM_V07_DATABASE_URL ?? process.env.DATABASE_URL;
const enabled = process.env.RUN_GOWM_V07_DB_INTEGRATION === "1" && databaseUrl !== undefined;
const runId = (process.env.GOWM_V07_RUN_ID ?? randomUUID()).replaceAll("-", "").slice(0, 20);
const scopeA = `v07-analysis-a-${runId}`;
const scopeB = `v07-analysis-b-${runId}`;
const analysisA = randomUUID();
const analysisB = randomUUID();
const resourceDigest = `sha256:${"a".repeat(64)}`;

let pool: Pool;

function inputSetDigest(
  members: Array<{ kind: string; id: string; version: string; hash: string | null }>
): `sha256:${string}` {
  const sorted = structuredClone(members).sort((left, right) =>
    [left.kind, left.id, left.version, left.hash ?? ""].join("\0")
      .localeCompare([right.kind, right.id, right.version, right.hash ?? ""].join("\0"))
  );
  return `sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`;
}

async function expectSqlState(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
    throw new Error(`expected PostgreSQL SQLSTATE ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

async function withRole<T>(role: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SET ROLE ${role}`);
    return await action(client);
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    client.release();
  }
}

async function insertAnalysis(analysisId: string, scope: string, hashCharacter: string): Promise<void> {
  await pool.query(
    `INSERT INTO public.analysis_record(
       analysis_id, data_scope_key, service_name, tool_name, tool_version,
       algorithm, algorithm_version, status, analysis_as_of,
       query_payload, result_payload, method_snapshot, snapshot_hash
     ) VALUES (
       $1::uuid, $2, 'v07-analysis-input-test', 'input-register', '1.0',
       'fixture', '1.0', 'COMPLETE', clock_timestamp(),
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $3
     )`,
    [analysisId, scope, `sha256:${hashCharacter.repeat(64)}`]
  );
}

describe.skipIf(!enabled)("v0.7 generic analysis resource input evidence", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    await pool.query(
      `INSERT INTO public.data_scope(scope_key, operational_domain, description)
       VALUES ($1, 'TEST', 'v0.7 analysis input scope A'),
              ($2, 'TEST', 'v0.7 analysis input scope B')`,
      [scopeA, scopeB]
    );
    await insertAnalysis(analysisA, scopeA, "1");
    await insertAnalysis(analysisB, scopeB, "2");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("registers versioned resource inputs idempotently and rejects identity conflicts", async () => {
    await withRole("gowm_analysis_writer", async (client) => {
      const parameters = [
        analysisA,
        1,
        "SUBJECT",
        "test.scope",
        "WORLD_OBJECT",
        "object-a",
        "v1",
        resourceDigest,
        42,
        "PINNED",
        "v07-analysis-input-test",
        null,
        null
      ];
      const first = await client.query<{ inserted: boolean }>(
        `SELECT public.register_analysis_resource_input(
           $1::uuid,$2::integer,$3,$4,$5,$6,$7,$8,$9::bigint,$10,$11,$12,$13::uuid
         ) AS inserted`,
        parameters
      );
      const replay = await client.query<{ inserted: boolean }>(
        `SELECT public.register_analysis_resource_input(
           $1::uuid,$2::integer,$3,$4,$5,$6,$7,$8,$9::bigint,$10,$11,$12,$13::uuid
         ) AS inserted`,
        parameters
      );
      expect(first.rows[0]?.inserted).toBe(true);
      expect(replay.rows[0]?.inserted).toBe(false);

      const conflict = [...parameters];
      conflict[7] = `sha256:${"b".repeat(64)}`;
      await expectSqlState(() => client.query(
        `SELECT public.register_analysis_resource_input(
           $1::uuid,$2::integer,$3,$4,$5,$6,$7,$8,$9::bigint,$10,$11,$12,$13::uuid
         )`,
        conflict
      ), "23505");
    });

    const stored = await pool.query<{
      resource_version: string;
      resource_content_hash: string;
      resource_world_version: string;
    }>(
      `SELECT resource_version, resource_content_hash, resource_world_version::text
       FROM public.analysis_resource_input
       WHERE analysis_id = $1::uuid AND input_no = 1`,
      [analysisA]
    );
    expect(stored.rows).toEqual([{
      resource_version: "v1",
      resource_content_hash: resourceDigest,
      resource_world_version: "42"
    }]);
  });

  it("rejects cross-scope source analyses and direct base-table writes", async () => {
    await withRole("gowm_analysis_writer", async (client) => {
      await expectSqlState(() => client.query(
        `SELECT public.register_analysis_resource_input(
           $1::uuid,2,'SOURCE_ANALYSIS','test.scope','ANALYSIS_RESULT','analysis-b','v1',
           NULL,NULL,'PINNED','v07-analysis-input-test',NULL,$2::uuid
         )`,
        [analysisA, analysisB]
      ), "42501");

      await expectSqlState(() => client.query(
        `INSERT INTO public.analysis_input_set(
           analysis_id,input_set_kind,item_count,item_set_digest,authority
         ) VALUES ($1::uuid,'DIRECT_INSERT',0,$2,'v07-analysis-input-test')`,
        [analysisA, `sha256:${"c".repeat(64)}`]
      ), "42501");
    });
  });

  it("records deterministic input-set digests idempotently and rejects conflicts", async () => {
    const members = [
      { kind: "OBSERVATION", id: "observation-b", version: "2", hash: `sha256:${"2".repeat(64)}` },
      { kind: "OBSERVATION", id: "observation-a", version: "1", hash: `sha256:${"1".repeat(64)}` }
    ];
    const digest = inputSetDigest(members);
    expect(inputSetDigest([...members].reverse())).toBe(digest);

    await withRole("gowm_analysis_writer", async (client) => {
      const first = await client.query<{ inserted: boolean }>(
        `SELECT public.register_analysis_input_set(
           $1::uuid,'HISTORY_INPUT_SET',$2::bigint,$3,$4,$5
         ) AS inserted`,
        [analysisA, members.length, digest, "artifact:v07-analysis-input-manifest", "v07-analysis-input-test"]
      );
      const replay = await client.query<{ inserted: boolean }>(
        `SELECT public.register_analysis_input_set(
           $1::uuid,'HISTORY_INPUT_SET',$2::bigint,$3,$4,$5
         ) AS inserted`,
        [analysisA, members.length, digest, "artifact:v07-analysis-input-manifest", "v07-analysis-input-test"]
      );
      expect(first.rows[0]?.inserted).toBe(true);
      expect(replay.rows[0]?.inserted).toBe(false);

      await expectSqlState(() => client.query(
        `SELECT public.register_analysis_input_set(
           $1::uuid,'HISTORY_INPUT_SET',$2::bigint,$3,$4,$5
         )`,
        [analysisA, members.length + 1, `sha256:${"d".repeat(64)}`, null, "v07-analysis-input-test"]
      ), "23505");
    });
  });

  it("enforces append-only evidence and scope-before-read views", async () => {
    await expectSqlState(() => pool.query(
      `UPDATE public.analysis_resource_input
       SET authority = 'mutated'
       WHERE analysis_id = $1::uuid AND input_no = 1`,
      [analysisA]
    ), "55000");
    await expectSqlState(() => pool.query(
      `DELETE FROM public.analysis_input_set
       WHERE analysis_id = $1::uuid AND input_set_kind = 'HISTORY_INPUT_SET'`,
      [analysisA]
    ), "55000");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE gowm_analysis_reader");
      expect((await client.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM gowm_analysis_v1.analysis_resource_input"
      )).rows[0]?.count).toBe(0);
      await client.query("SELECT gowm_analysis_v1.set_data_scope($1)", [scopeA]);
      expect((await client.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM gowm_analysis_v1.analysis_resource_input"
      )).rows[0]?.count).toBe(1);
      expect((await client.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM gowm_analysis_v1.analysis_input_set"
      )).rows[0]?.count).toBe(1);
      await client.query("SELECT gowm_analysis_v1.set_data_scope($1)", [scopeB]);
      expect((await client.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM gowm_analysis_v1.analysis_resource_input"
      )).rows[0]?.count).toBe(0);
      await expectSqlState(() => client.query("SELECT count(*) FROM public.analysis_resource_input"), "42501");
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
