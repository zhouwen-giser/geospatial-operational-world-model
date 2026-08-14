import { createHash } from "node:crypto";
import { databasePool, closeDatabasePool, withTransaction } from "../packages/runtime/src/db.js";
import { ProjectionProcessor } from "../packages/runtime/src/projection.js";
import { WorldRepository } from "../packages/runtime/src/world-repository.js";

/**
 * Rebuild one observation-derived object. This intentionally validates only the
 * authoritative current-state/geometry/provenance core. Global situation counters
 * are append-derived and are rebuilt separately in a production replay job.
 */
async function main(): Promise<void> {
  const subjectId = argument("--subject") ?? process.env.REPLAY_SUBJECT_ID;
  if (!subjectId) throw new Error("usage: npm run replay -- --subject <observation-derived-object-id>");

  const pool = databasePool();
  const world = new WorldRepository(pool);
  const processor = new ProjectionProcessor(pool);
  const before = await world.getObject(subjectId, false);
  if (!before?.provenance?.sourceObservationId) {
    throw new Error(`${subjectId} has no observation-derived current state; replay refuses manual-only state`);
  }
  const observationIds = await pool.query<{ observation_id: string }>(
    `SELECT observation_id FROM world_observation
     WHERE subject_id = $1 AND entity_binding_status<>'CANDIDATE'
     ORDER BY observed_at, received_at, observation_id`,
    [subjectId]
  );
  if (!observationIds.rowCount) throw new Error(`no observations found for ${subjectId}`);

  const expected = canonical(before);
  await withTransaction(pool, async (client) => {
    await client.query("DELETE FROM object_area_membership WHERE object_id = $1", [subjectId]);
    // MobilityDB tracklet versions are immutable evidence projections and are
    // not part of World State replay. Rebuilding World State must not delete or
    // mutate them; a changed clock/rule/input publishes a new tracklet version.
    await client.query("DELETE FROM world_object_geometry WHERE object_id = $1", [subjectId]);
    await client.query("DELETE FROM world_object_state WHERE object_id = $1", [subjectId]);
    await client.query(
      `DELETE FROM world_event WHERE subject_id = $1 AND event_type <> 'ObservationReceived'`,
      [subjectId]
    );
    await client.query(
      `UPDATE world_observation
       SET status = 'accepted', projected_at = NULL, rejection_reason = NULL
       WHERE subject_id = $1`,
      [subjectId]
    );
    await client.query(
      `INSERT INTO projection_queue (observation_id)
       SELECT observation_id FROM world_observation WHERE subject_id = $1
         AND entity_binding_status<>'CANDIDATE'
       ON CONFLICT (observation_id) DO UPDATE SET
         attempts = 0, available_at = clock_timestamp(), locked_at = NULL,
         processed_at = NULL, last_error = NULL`,
      [subjectId]
    );
  });

  for (const row of observationIds.rows) await processor.process(row.observation_id);
  const rebuilt = await world.getObject(subjectId, false);
  if (!rebuilt) throw new Error("replay did not rebuild state");
  const actual = canonical(rebuilt);
  const match = expected.hash === actual.hash;
  process.stdout.write(`${JSON.stringify({
    subjectId,
    observationCount: observationIds.rowCount,
    expectedHash: expected.hash,
    actualHash: actual.hash,
    match,
    comparedFields: ["type", "geometry", "state", "confidence", "observedAt", "provenance"]
  }, null, 2)}\n`);
  if (!match) process.exitCode = 2;
}

function canonical(object: NonNullable<Awaited<ReturnType<WorldRepository["getObject"]>>>): { json: string; hash: string } {
  const value = {
    type: object.type,
    geometry: object.geometry ?? null,
    state: object.state,
    confidence: object.confidence,
    observedAt: object.observedAt ?? null,
    provenance: object.provenance ?? null
  };
  const json = stable(value);
  return { json, hash: createHash("sha256").update(json).digest("hex") };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(closeDatabasePool);
