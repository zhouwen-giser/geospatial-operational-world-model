import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const observationRepository = readFileSync(
  resolve("packages/runtime/src/observation-repository.ts"),
  "utf8"
);
const trackletRuntimeMigration = readFileSync(
  resolve("database/migrations/066_tracklet_finalization_runtime.sql"),
  "utf8"
);
const trackletRuntimeAssertions = readFileSync(
  resolve("database/tests/049_tracklet_finalization_runtime_assertions.sql"),
  "utf8"
);
const projectionWorkerEntrypoint = readFileSync(
  resolve("services/projection-worker/src/index.ts"),
  "utf8"
);
const worldPlatformCompose = readFileSync(
  resolve("docker-compose.world-platform.yml"),
  "utf8"
);

describe("historical tracklet dirty-queue architecture", () => {
  it("keeps canonical observation persistence free of synchronous tracklet rebuild work", () => {
    expect(observationRepository).not.toMatch(/gowm_rebuild_mobility_tracklet/iu);
    expect(observationRepository).not.toMatch(/rebuild_mobility_tracklet_v2/iu);
    expect(observationRepository).not.toMatch(/claim_tracklet_projection/iu);
    expect(observationRepository).not.toMatch(/complete_tracklet_projection/iu);
    expect(observationRepository).not.toMatch(/fail_tracklet_projection/iu);
  });

  it("uses the position AFTER INSERT trigger only to enqueue the scoped dirty key", () => {
    const functionStart = trackletRuntimeMigration.indexOf(
      "CREATE FUNCTION gowm_history.enqueue_tracklet_projection_from_position()"
    );
    const triggerEnd = trackletRuntimeMigration.indexOf(
      "CREATE FUNCTION gowm_history.claim_tracklet_projection(",
      functionStart
    );
    expect(functionStart).toBeGreaterThan(-1);
    expect(triggerEnd).toBeGreaterThan(functionStart);

    const triggerSlice = trackletRuntimeMigration.slice(functionStart,triggerEnd);
    const normalizedTrigger = triggerSlice.replace(/\s+/gu," ");
    expect(normalizedTrigger).toContain(
      "CREATE TRIGGER position_measurement_tracklet_dirty_queue AFTER INSERT ON public.position_measurement"
    );
    expect(normalizedTrigger).toContain(
      "EXECUTE FUNCTION gowm_history.enqueue_tracklet_projection_from_position()"
    );
    expect(triggerSlice).toContain("PERFORM gowm_history.enqueue_tracklet_projection(");
    expect(triggerSlice).not.toMatch(/gowm_rebuild_mobility_tracklet|rebuild_mobility_tracklet_v2/iu);
  });

  it("proves the real observation-to-position insert chain fires after the queue fence", () => {
    const fenceEnd = trackletRuntimeAssertions.indexOf("$projection_queue_fence$;");
    const chain = [
      "INSERT INTO public.source_clock_model(",
      "INSERT INTO public.world_observation(",
      "INSERT INTO public.observation_time_solution(",
      "INSERT INTO public.measurement(",
      "INSERT INTO public.position_measurement("
    ];
    let prior = fenceEnd;
    expect(fenceEnd).toBeGreaterThan(-1);
    for (const statement of chain) {
      const position = trackletRuntimeAssertions.indexOf(statement,prior + 1);
      expect(position).toBeGreaterThan(prior);
      prior = position;
    }

    const sealStart = trackletRuntimeAssertions.indexOf("DO $seal_tracklet$",prior);
    expect(sealStart).toBeGreaterThan(prior);
    const triggerRegression = trackletRuntimeAssertions.slice(fenceEnd,sealStart);
    expect(triggerRegression).not.toContain("gowm_history.enqueue_tracklet_projection(");
    expect(triggerRegression).toContain("'history-tracklet-a'");
    expect(triggerRegression).toContain("'history-tracklet-source'");
    expect(triggerRegression).toContain("'vehicle-49-trigger'");
    expect(triggerRegression).toContain("'session-49-trigger'");
    expect(triggerRegression).toContain("queued.profile_key <> 'source-local-default'");
    expect(triggerRegression).toContain("queue.desired_input_set_hash = expected_hash");
  });

  it("binds historical stages to the dedicated controlled worker login", () => {
    expect(projectionWorkerEntrypoint).toContain("HISTORICAL_WORKER_DATABASE_URL");
    expect(projectionWorkerEntrypoint).toContain(
      "createPostgresHistoricalProjectionStages(historicalPool)"
    );
    expect(projectionWorkerEntrypoint).not.toContain(
      "createPostgresHistoricalProjectionStages(pool)"
    );
    expect(worldPlatformCompose).toContain(
      "postgresql://gowm_history_worker_service:${HISTORICAL_WORKER_DB_PASSWORD"
    );
    expect(trackletRuntimeAssertions).toContain(
      "history worker login received direct queue mutation privileges"
    );
  });
});
