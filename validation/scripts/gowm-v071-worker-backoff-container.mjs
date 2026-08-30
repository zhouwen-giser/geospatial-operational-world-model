import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const image = required("GOWM_V071_QUALIFICATION_IMAGE");
const qualificationNetwork = required("GOWM_V071_QUALIFICATION_NETWORK");
const databaseContainer = required("GOWM_V071_DATABASE_CONTAINER");
const mainDatabaseUrl = required("GOWM_V071_MAIN_DATABASE_URL");
const candidateCommit = git(["rev-parse", "HEAD"]);
const imageCommit = docker([
  "image", "inspect", image,
  "--format", "{{ index .Config.Labels \"org.opencontainers.image.revision\" }}"
]);
if (imageCommit.toLowerCase() !== candidateCommit) {
  throw new Error("qualification image is not labeled with the exact candidate commit");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const workerContainer = `gowm-v071-worker-${suffix}`;
const signalContainer = `gowm-v071-worker-signal-${suffix}`;
const recoveryNetwork = `gowm-v071-worker-recovery-${suffix}`;
const taskId = `gowm-v071-worker-${suffix}`;
const historicalDatabaseUrl = databaseUrlForHost(mainDatabaseUrl, "historical-postgres");
const signalDatabaseUrl = databaseUrlForHost(mainDatabaseUrl, "signal-historical-postgres");
const intervalToleranceMs = 25;

let recoveryNetworkCreated = false;
let workerCreated = false;
let workerRunning = false;
let signalCreated = false;
let signalRunning = false;
let databaseConnectedToRecovery = false;

try {
  docker([
    "network", "create",
    "--label", `gowm.v071.worker-gate=${candidateCommit}`,
    recoveryNetwork
  ]);
  recoveryNetworkCreated = true;

  docker([
    "create", "--name", workerContainer,
    "--label", `gowm.v071.worker-gate=${candidateCommit}`,
    "--network", qualificationNetwork,
    ...workerEnvironment(mainDatabaseUrl, historicalDatabaseUrl, {
      baseDelayMs: 100,
      maxDelayMs: 800,
      pollMs: 50
    }),
    image,
    "node", "dist/services/projection-worker/src/index.js"
  ]);
  workerCreated = true;
  docker(["start", workerContainer]);
  workerRunning = true;
  docker(["network", "connect", recoveryNetwork, workerContainer]);
  const initialRecoveryMembers = networkContainerNames(recoveryNetwork);
  const initialWorkerAliases = containerNetworkAliases(workerContainer, recoveryNetwork);
  if (JSON.stringify(initialRecoveryMembers) !== JSON.stringify([workerContainer])
      || initialWorkerAliases.includes("historical-postgres")) {
    throw new Error("dedicated recovery network was not isolated before failure observation");
  }

  const initialIdentity = await waitForRunningIdentity(workerContainer, 5_000);
  const backoffRampEvents = (await waitForBackoffEventCount(
    workerContainer,
    5,
    60_000
  )).slice(0, 5);
  verifyBackoffRamp(backoffRampEvents, intervalToleranceMs);

  // Docker Desktop can spend several seconds resolving the deliberately
  // unavailable Historical database before the first structured failure is
  // emitted. Anchor the bounded observation to a real capped-backoff event so
  // container/bootstrap latency is readiness time, not retry-window time.
  const failedWindowElapsedMs = 3_200;
  const failedWindowStartedAt = backoffRampEvents.at(-1).timestampMs;
  const failedWindowEndedAt = failedWindowStartedAt + failedWindowElapsedMs;
  await delay(failedWindowElapsedMs);
  const eventsAtFailedWindowEnd = containerBackoffEvents(workerContainer);
  const failedWindowEvents = eventsAtFailedWindowEnd.filter((event) =>
    event.timestampMs >= failedWindowStartedAt && event.timestampMs <= failedWindowEndedAt);
  verifyFailedWindow(failedWindowEvents, failedWindowElapsedMs, intervalToleranceMs);

  // Seed immediately after a logged failure decision, while the worker is in
  // its capped 800 ms wait. This prevents the fixture from appearing between
  // the operational and historical stages of an already-running tick.
  const recoverySyncEvent = await waitForNewBackoffEvent(
    workerContainer,
    eventsAtFailedWindowEnd.length,
    30_000
  );
  if (recoverySyncEvent.delayMs !== 800) {
    throw new Error("worker was not at its capped delay before the recovery transition");
  }
  const queue = enqueueProjectionWork(databaseContainer, taskId);
  const eventsAfterQueueSeed = containerBackoffEvents(workerContainer).length;
  const queuedOutageEvent = await waitForNewBackoffEvent(
    workerContainer,
    eventsAfterQueueSeed,
    30_000
  );
  const queuedOutageState = projectionQueueState(databaseContainer, queue);
  if (queuedOutageEvent.delayMs !== 800
      || queuedOutageState.state !== "QUEUED"
      || queuedOutageState.attempts !== 0
      || queuedOutageState.generation !== 0) {
    throw new Error("projection work was not held unclaimed while the historical database was unavailable");
  }
  const eventsBeforeRecovery = containerBackoffEvents(workerContainer).length;
  docker([
    "network", "connect", "--alias", "historical-postgres",
    recoveryNetwork, databaseContainer
  ]);
  databaseConnectedToRecovery = true;
  const recoveredDatabaseAliases = containerNetworkAliases(databaseContainer, recoveryNetwork);
  if (!recoveredDatabaseAliases.includes("historical-postgres")) {
    throw new Error("qualification database did not acquire the historical recovery alias");
  }
  const recoveryWorkerAddress = containerNetworkAddress(workerContainer, recoveryNetwork);

  const completedQueue = await waitForQueueCompletion(databaseContainer, queue, 20_000);
  if (completedQueue.attempts !== 1 || completedQueue.generation !== 1) {
    throw new Error("recovered projection work was not completed by its first fenced claim");
  }
  if (completedQueue.intervalCount < 1 || completedQueue.revisionCount < 1) {
    throw new Error("recovered projection work did not materialize interval evidence");
  }

  // Queue completion happens inside the first historical stage. Give that same
  // tick time to finish so its successful decision resets the in-memory
  // consecutive-failure counter before making the database unavailable again.
  await delay(1_000);
  const recoveredIdentity = inspectContainer(workerContainer);
  assertSameRunningProcess(initialIdentity, recoveredIdentity);
  const eventsBeforeDisconnect = containerBackoffEvents(workerContainer);
  if (eventsBeforeDisconnect.length < eventsBeforeRecovery) {
    throw new Error("worker backoff log history was truncated during recovery");
  }

  docker(["network", "disconnect", recoveryNetwork, databaseContainer]);
  databaseConnectedToRecovery = false;
  if (networkContainerNames(recoveryNetwork).includes(databaseContainer)) {
    throw new Error("qualification database remained attached after the recovery disconnect");
  }
  // Docker network disconnect does not necessarily close an established TCP
  // session. Terminate only sessions sourced from the worker's recovery-network
  // address so the Historical pool must reconnect, while its main-database
  // sessions on the qualification network remain untouched.
  const terminatedHistoricalConnections = terminateHistoricalWorkerConnections(
    databaseContainer,
    recoveryWorkerAddress
  );
  if (terminatedHistoricalConnections < 1) {
    throw new Error("qualification did not identify an established Historical worker connection");
  }
  const resetEvent = await waitForNewBackoffEvent(
    workerContainer,
    eventsBeforeDisconnect.length,
    30_000
  );
  if (resetEvent.consecutiveStageFailures !== 1 || resetEvent.delayMs !== 100
      || !isHistoricalDatabaseUnavailable(resetEvent)) {
    throw new Error("successful automatic recovery did not reset the worker backoff state");
  }
  const identityAfterReset = inspectContainer(workerContainer);
  assertSameRunningProcess(initialIdentity, identityAfterReset);

  docker([
    "create", "--name", signalContainer,
    "--label", `gowm.v071.worker-gate=${candidateCommit}`,
    "--network", qualificationNetwork,
    ...workerEnvironment(mainDatabaseUrl, signalDatabaseUrl, {
      baseDelayMs: 10_000,
      maxDelayMs: 10_000,
      pollMs: 50
    }),
    image,
    "node", "dist/services/projection-worker/src/index.js"
  ]);
  signalCreated = true;
  docker(["start", signalContainer]);
  signalRunning = true;
  const signalIdentity = await waitForRunningIdentity(signalContainer, 5_000);
  const signalBackoff = await waitForNewBackoffEvent(signalContainer, 0, 15_000);
  if (signalBackoff.consecutiveStageFailures !== 1 || signalBackoff.delayMs !== 10_000
      || !isHistoricalDatabaseUnavailable(signalBackoff)) {
    throw new Error("signal qualification worker did not enter the required ten-second wait");
  }

  const stopStartedAt = Date.now();
  docker(["stop", "--time", "5", signalContainer]);
  signalRunning = false;
  const stopElapsedMs = Date.now() - stopStartedAt;
  const stoppedSignalIdentity = inspectContainer(signalContainer);
  if (stopElapsedMs >= 5_000) {
    throw new Error("SIGTERM did not interrupt the ten-second worker wait within five seconds");
  }
  if (stoppedSignalIdentity.running || stoppedSignalIdentity.exitCode !== 0) {
    throw new Error("signal qualification worker did not exit cleanly after SIGTERM");
  }
  if (stoppedSignalIdentity.exitCode === 137 || stoppedSignalIdentity.oomKilled) {
    throw new Error("signal qualification worker required a forced kill");
  }
  if (signalIdentity.id !== stoppedSignalIdentity.id
      || signalIdentity.startedAt !== stoppedSignalIdentity.startedAt) {
    throw new Error("signal qualification did not stop the process that entered the wait");
  }
  docker(["rm", signalContainer]);
  signalCreated = false;

  docker(["stop", "--time", "5", workerContainer]);
  workerRunning = false;
  const stoppedWorkerIdentity = inspectContainer(workerContainer);
  if (stoppedWorkerIdentity.exitCode !== 0 || stoppedWorkerIdentity.oomKilled) {
    throw new Error("automatic-recovery worker did not shut down cleanly");
  }
  docker(["rm", workerContainer]);
  workerCreated = false;
  docker(["network", "rm", recoveryNetwork]);
  recoveryNetworkCreated = false;

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    gate: "GOWM_V071_HISTORICAL_WORKER_BACKOFF_READY",
    candidateCommit,
    imageCommit: imageCommit.toLowerCase(),
    initialBackoffRamp: {
      observedBackoffEvents: backoffRampEvents.length,
      consecutiveStageFailures: backoffRampEvents.map((item) => item.consecutiveStageFailures),
      delayMs: backoffRampEvents.map((item) => item.delayMs),
      adjacentEventIntervalsMs: backoffRampEvents.slice(1).map((item, index) =>
        item.timestampMs - backoffRampEvents[index].timestampMs),
      intervalToleranceMs
    },
    failedWindow: {
      observationWindowMs: failedWindowElapsedMs,
      observedBackoffEvents: failedWindowEvents.length,
      consecutiveStageFailures: failedWindowEvents.map((item) => item.consecutiveStageFailures),
      delayMs: failedWindowEvents.map((item) => item.delayMs),
      adjacentEventIntervalsMs: failedWindowEvents.slice(1).map((item, index) =>
        item.timestampMs - failedWindowEvents[index].timestampMs),
      intervalToleranceMs,
      maximumAllowedEvents: maximumCappedEvents(failedWindowElapsedMs, 800, intervalToleranceMs),
      cappedDelayObserved: true,
      failedHistoricalStagesPerTick: 4,
      failureKind: "DATABASE_UNAVAILABLE",
      initialHistoricalAliasPresent: initialWorkerAliases.includes("historical-postgres")
    },
    automaticRecovery: {
      containerId: initialIdentity.id,
      processPid: initialIdentity.pid,
      startedAt: initialIdentity.startedAt,
      sameContainerId: initialIdentity.id === recoveredIdentity.id,
      sameProcessId: initialIdentity.pid === recoveredIdentity.pid,
      sameStartedAt: initialIdentity.startedAt === recoveredIdentity.startedAt,
      restartCountBefore: initialIdentity.restartCount,
      restartCountAfter: recoveredIdentity.restartCount,
      queueState: completedQueue.state,
      queueAttempts: completedQueue.attempts,
      queueGeneration: completedQueue.generation,
      materializedIntervals: completedQueue.intervalCount,
      materializedRevisions: completedQueue.revisionCount,
      synchronizedAfterCappedDelayMs: recoverySyncEvent.delayMs,
      queuedOutageDelayMs: queuedOutageEvent.delayMs,
      queueStateBeforeRecovery: queuedOutageState.state,
      queueAttemptsBeforeRecovery: queuedOutageState.attempts,
      recoveryAliasConnected: recoveredDatabaseAliases.includes("historical-postgres"),
      workerRestarted: false
    },
    resetAfterDisconnect: {
      consecutiveStageFailures: resetEvent.consecutiveStageFailures,
      delayMs: resetEvent.delayMs,
      terminatedHistoricalConnections,
      sameContainerId: initialIdentity.id === identityAfterReset.id,
      sameProcessId: initialIdentity.pid === identityAfterReset.pid
    },
    shutdown: {
      separateSignalOnlyContainer: true,
      containerId: signalIdentity.id,
      processPid: signalIdentity.pid,
      pendingDelayMs: signalBackoff.delayMs,
      signal: "SIGTERM",
      stopElapsedMs,
      maximumAllowedMs: 5_000,
      exitCode: stoppedSignalIdentity.exitCode,
      oomKilled: stoppedSignalIdentity.oomKilled,
      forcedKill: false
    },
    cleanup: {
      dedicatedContainersRemoved: 2,
      dedicatedNetworkRemoved: true,
      qualificationDatabasePreserved: true,
      qualificationNetworkPreserved: true
    },
    connectionDetailsEmitted: false
  })}\n`);
} finally {
  if (databaseConnectedToRecovery) {
    docker(["network", "disconnect", "--force", recoveryNetwork, databaseContainer], { allowFailure: true });
  }
  if (signalRunning || signalCreated) {
    docker(["rm", "--force", signalContainer], { allowFailure: true });
  }
  if (workerRunning || workerCreated) {
    docker(["rm", "--force", workerContainer], { allowFailure: true });
  }
  if (recoveryNetworkCreated) {
    docker(["network", "rm", recoveryNetwork], { allowFailure: true });
  }
}

function workerEnvironment(databaseUrl, historicalUrl, options) {
  return [
    "--env", `DATABASE_URL=${databaseUrl}`,
    "--env", `HISTORICAL_WORKER_DATABASE_URL=${historicalUrl}`,
    "--env", "MQTT_URL=mqtt://127.0.0.1:1",
    "--env", "MQTT_CONNECT_TIMEOUT_MS=100",
    "--env", "PROJECTION_BATCH_SIZE=10",
    "--env", `PROJECTION_POLL_MS=${options.pollMs}`,
    "--env", `HISTORICAL_PROJECTION_RETRY_DELAY_MS=${options.baseDelayMs}`,
    "--env", `HISTORICAL_PROJECTION_MAX_RETRY_DELAY_MS=${options.maxDelayMs}`,
    "--env", "HISTORICAL_PROJECTION_BACKOFF_MULTIPLIER=2"
  ];
}

function verifyBackoffRamp(events, toleranceMs) {
  const expectedDelays = [100, 200, 400, 800, 800];
  if (events.length !== expectedDelays.length) {
    throw new Error("worker did not emit the required backoff ramp");
  }
  if (JSON.stringify(events.map((item) => item.delayMs)) !== JSON.stringify(expectedDelays)) {
    throw new Error("worker backoff sequence is not the expected capped exponential series");
  }
  for (const [index, event] of events.entries()) {
    if (!isHistoricalDatabaseUnavailable(event)) {
      throw new Error("worker failure window was not caused by the isolated historical database");
    }
    if (event.consecutiveStageFailures !== index + 1) {
      throw new Error("worker consecutive stage-failure counters are not monotonic");
    }
    if (index === 0) continue;
    const previous = events[index - 1];
    const intervalMs = event.timestampMs - previous.timestampMs;
    if (intervalMs < previous.delayMs - toleranceMs) {
      throw new Error("worker emitted a retry before its prior backoff delay elapsed");
    }
  }
}

function verifyFailedWindow(events, elapsedMs, toleranceMs) {
  if (elapsedMs < 3_000) throw new Error("worker failure observation window was shorter than three seconds");
  if (events.length < 1) throw new Error("worker emitted no capped backoff event in the bounded failure window");
  if (events.length > maximumCappedEvents(elapsedMs, 800, toleranceMs)) {
    throw new Error("worker emitted too many retries during the bounded failure window");
  }
  for (const [index, event] of events.entries()) {
    if (!isHistoricalDatabaseUnavailable(event)) {
      throw new Error("worker failure window was not caused by the isolated historical database");
    }
    if (event.delayMs !== 800) {
      throw new Error("worker backoff delay did not remain at the configured cap");
    }
    if (index === 0) continue;
    const previous = events[index - 1];
    if (event.consecutiveStageFailures !== previous.consecutiveStageFailures + 1) {
      throw new Error("worker consecutive stage-failure counters are not monotonic");
    }
    const intervalMs = event.timestampMs - previous.timestampMs;
    if (intervalMs < previous.delayMs - toleranceMs) {
      throw new Error("worker emitted a retry before its prior backoff delay elapsed");
    }
  }
}

function maximumCappedEvents(elapsedMs, cappedDelayMs, toleranceMs) {
  return 1 + Math.floor(elapsedMs / (cappedDelayMs - toleranceMs));
}

function isHistoricalDatabaseUnavailable(event) {
  const expectedStages = [
    "TASK_INTERVALS",
    "TRACKLET_REBUILD",
    "TRACKLET_FINALIZATION",
    "HISTORICAL_TRAJECTORIES"
  ];
  return event.failedHistoricalStages.length === expectedStages.length
    && event.failedHistoricalStages.every((failure, index) =>
      failure.stage === expectedStages[index] && failure.failureKind === "DATABASE_UNAVAILABLE");
}

function enqueueProjectionWork(container, operationalTaskId) {
  const scope = psql(
    container,
    "SELECT scope_key FROM public.data_scope ORDER BY (scope_key='default') DESC, scope_key LIMIT 1"
  );
  if (!scope || scope.includes("\n") || scope.includes("\r")) {
    throw new Error("qualification database has no unambiguous data scope");
  }
  const desiredHash = psql(container, `
    BEGIN;
    INSERT INTO public.operational_task_event(
      data_scope_key,event_id,operational_task_id,event_type,event_time,received_time,
      actor_reference_keys,target_reference_keys,payload,confidence,provenance,
      world_version,source_authority,source_event_key,source_revision_no,
      arrival_classification,projection_disposition,content_hash
    ) VALUES
      (
        :'scope', :'task_id' || '-start', :'task_id', 'EXECUTION_STARTED_OBSERVED',
        clock_timestamp() - interval '2 seconds', clock_timestamp() - interval '2 seconds',
        '[]'::jsonb, '[]'::jsonb, jsonb_build_object('taskType','WORKER_RECOVERY_QUALIFICATION'),
        1, jsonb_build_array(jsonb_build_object('authority','gowm-v071-worker-gate')),
        nextval('public.world_version_seq'), 'gowm-v071-worker-gate', :'task_id' || '-start', 1,
        'CURRENT','PENDING',public.grounding_sha256(:'task_id' || ':start')
      ),
      (
        :'scope', :'task_id' || '-stop', :'task_id', 'EXECUTION_STOPPED_OBSERVED',
        clock_timestamp() - interval '1 second', clock_timestamp() - interval '1 second',
        '[]'::jsonb, '[]'::jsonb, jsonb_build_object('taskType','WORKER_RECOVERY_QUALIFICATION'),
        1, jsonb_build_array(jsonb_build_object('authority','gowm-v071-worker-gate')),
        nextval('public.world_version_seq'), 'gowm-v071-worker-gate', :'task_id' || '-stop', 1,
        'CURRENT','PENDING',public.grounding_sha256(:'task_id' || ':stop')
      );
    SELECT gowm_history.enqueue_task_interval_projection(:'scope', :'task_id');
    COMMIT;
  `, { scope, task_id: operationalTaskId });
  if (!/^sha256:[0-9a-f]{64}$/u.test(desiredHash)) {
    throw new Error("qualification projection work did not produce a deterministic queue hash");
  }
  return { scope, taskId: operationalTaskId, desiredHash };
}

async function waitForQueueCompletion(container, queue, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = projectionQueueState(container, queue);
    if (latest.state === "COMPLETED") return latest;
    if (latest.attempts > 1) {
      throw new Error("qualification projection work required more than one claim attempt");
    }
    await delay(100);
  }
  throw new Error(`qualification projection work did not complete; last state was ${latest?.state ?? "MISSING"}`);
}

function projectionQueueState(container, queue) {
  const row = psql(container, `
    SELECT queue.state, queue.attempts, queue.generation,
           (SELECT count(*) FROM gowm_history.task_execution_interval interval
            WHERE interval.data_scope_key=queue.data_scope_key
              AND interval.operational_task_id=queue.operational_task_id),
           (SELECT count(*)
            FROM gowm_history.task_execution_interval interval
            JOIN gowm_history.task_execution_interval_revision revision USING (interval_id)
            WHERE interval.data_scope_key=queue.data_scope_key
              AND interval.operational_task_id=queue.operational_task_id)
    FROM gowm_history.task_interval_projection_queue queue
    WHERE queue.data_scope_key=:'scope'
      AND queue.operational_task_id=:'task_id'
      AND queue.desired_event_set_hash=:'desired_hash'
  `, {
    scope: queue.scope,
    task_id: queue.taskId,
    desired_hash: queue.desiredHash
  }, "|");
  const [state, attempts, generation, intervalCount, revisionCount] = row.split("|");
  if (!state) return { state: "MISSING", attempts: 0, generation: 0, intervalCount: 0, revisionCount: 0 };
  return {
    state,
    attempts: integer(attempts, "queue attempts"),
    generation: integer(generation, "queue generation"),
    intervalCount: integer(intervalCount, "materialized interval count"),
    revisionCount: integer(revisionCount, "materialized interval revision count")
  };
}

function psql(container, sql, variables = {}, fieldSeparator = "|") {
  const variableArguments = Object.entries(variables).flatMap(([name, value]) => [
    "--set", `${name}=${String(value)}`
  ]);
  return docker([
    "exec", "--interactive", container,
    "psql", "--username", "gowm", "--dbname", "gowm",
    "--quiet", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1",
    "--field-separator", fieldSeparator,
    ...variableArguments,
    "--file", "-"
  ], { input: sql });
}

async function waitForNewBackoffEvent(container, priorCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = containerBackoffEvents(container);
    if (events.length > priorCount) return events[priorCount];
    const identity = inspectContainer(container);
    if (!identity.running) throw new Error("worker exited before emitting the expected backoff event");
    await delay(100);
  }
  throw new Error("worker did not emit the expected backoff event before the deadline");
}

function terminateHistoricalWorkerConnections(container, clientAddress) {
  return integer(psql(container, `
    SELECT count(*)
    FROM (
      SELECT pg_terminate_backend(pid) AS terminated
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND datname = current_database()
        AND usename = current_user
        AND client_addr = :'client_address'::inet
    ) candidates
    WHERE terminated
  `, { client_address: clientAddress }), "terminated Historical worker connections");
}

async function waitForBackoffEventCount(container, requiredCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    latest = containerBackoffEvents(container);
    if (latest.length >= requiredCount) return latest;
    const identity = inspectContainer(container);
    if (!identity.running) throw new Error("worker exited before emitting the required backoff ramp");
    await delay(100);
  }
  throw new Error(
    `worker emitted ${latest.length} of ${requiredCount} required backoff events before the deadline`
  );
}

function containerBackoffEvents(container) {
  return backoffEvents(docker(["logs", "--timestamps", container], { trim: false }));
}

function backoffEvents(output) {
  return output.split(/\r?\n/u).flatMap((line) => {
    const separator = line.indexOf(" ");
    if (separator < 1) return [];
    const timestampMs = Date.parse(line.slice(0, separator));
    if (!Number.isFinite(timestampMs)) return [];
    try {
      const value = JSON.parse(line.slice(separator + 1));
      if (value?.event !== "historical_projection_backoff") return [];
      return [{
        timestampMs,
        consecutiveStageFailures: integer(value.consecutiveStageFailures, "consecutive stage failures"),
        delayMs: integer(value.delayMs, "worker backoff delay"),
        failedHistoricalStages: Array.isArray(value.failedHistoricalStages)
          ? value.failedHistoricalStages.map((failure) => ({
              stage: String(failure?.stage ?? ""),
              failureKind: String(failure?.failureKind ?? "")
            }))
          : []
      }];
    } catch {
      return [];
    }
  }).sort((left, right) => left.timestampMs - right.timestampMs);
}

async function waitForRunningIdentity(container, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = inspectContainer(container);
    if (identity.running && identity.pid > 0) return identity;
    await delay(50);
  }
  throw new Error("worker container did not enter the running state");
}

function inspectContainer(container) {
  const output = docker([
    "inspect", "--format",
    "{{.Id}}|{{.State.Pid}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Running}}|{{.State.ExitCode}}|{{.State.OOMKilled}}",
    container
  ]);
  const [id, pid, startedAt, restartCount, running, exitCode, oomKilled] = output.split("|");
  if (!/^[0-9a-f]{64}$/u.test(id ?? "")) throw new Error("worker container identity is invalid");
  return {
    id,
    pid: integer(pid, "container process id"),
    startedAt,
    restartCount: integer(restartCount, "container restart count"),
    running: running === "true",
    exitCode: integer(exitCode, "container exit code"),
    oomKilled: oomKilled === "true"
  };
}

function networkContainerNames(network) {
  return docker([
    "network", "inspect", "--format",
    "{{range .Containers}}{{println .Name}}{{end}}",
    network
  ]).split(/\r?\n/u).filter(Boolean).sort();
}

function containerNetworkAliases(container, network) {
  const output = docker([
    "inspect", "--format",
    `{{json (index .NetworkSettings.Networks "${network}")}}`,
    container
  ]);
  let attachment;
  try {
    attachment = JSON.parse(output);
  } catch {
    throw new Error("unable to inspect the dedicated recovery network attachment");
  }
  return Array.isArray(attachment?.Aliases)
    ? attachment.Aliases.map((alias) => String(alias)).sort()
    : [];
}

function containerNetworkAddress(container, network) {
  const output = docker([
    "inspect", "--format",
    `{{json (index .NetworkSettings.Networks "${network}")}}`,
    container
  ]);
  let attachment;
  try {
    attachment = JSON.parse(output);
  } catch {
    throw new Error("unable to inspect the dedicated recovery network address");
  }
  const address = String(attachment?.IPAddress ?? "").trim();
  if (!address || address.includes("\n") || address.includes("\r")) {
    throw new Error("worker has no unambiguous dedicated recovery network address");
  }
  return address;
}

function assertSameRunningProcess(before, after) {
  if (!after.running || after.pid <= 0) throw new Error("automatic-recovery worker is not running");
  if (before.id !== after.id || before.pid !== after.pid || before.startedAt !== after.startedAt) {
    throw new Error("automatic recovery replaced or restarted the worker process");
  }
  if (before.restartCount !== 0 || after.restartCount !== 0) {
    throw new Error("automatic recovery relied on a container restart");
  }
}

function databaseUrlForHost(databaseUrl, hostname) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("GOWM_V071_MAIN_DATABASE_URL is not a valid URL");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error("GOWM_V071_MAIN_DATABASE_URL must use PostgreSQL");
  }
  parsed.hostname = hostname;
  return parsed.toString();
}

function integer(value, name) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`);
  return parsed;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function git(arguments_) {
  const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("unable to resolve exact source identity");
  return result.stdout.trim().toLowerCase();
}

function docker(arguments_, options = {}) {
  const result = spawnSync("docker", arguments_, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    input: options.input,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`docker command failed: ${arguments_[0]} ${arguments_[1] ?? ""}`);
  }
  const output = `${result.stdout}${result.stderr}`;
  return options.trim === false ? output : output.trim();
}
