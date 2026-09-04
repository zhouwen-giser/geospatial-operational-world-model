import pg from "pg";
import { UGV_AUTHORITY_TOPICS } from "../../packages/integrations/ugv-mqtt-ingest-core/src/contracts.js";

const databaseUrl = process.env.UGV_MQTT_TEST_DATABASE_URL;
const statusUrl = process.env.UGV_MQTT_INGEST_STATUS_URL;
const clientId = process.env.UGV_MQTT_HARNESS_CLIENT_ID;
const trackerSessionKey = process.env.UGV_MQTT_HARNESS_TRACKER_SESSION_KEY;
if (!databaseUrl || !statusUrl || !clientId || !trackerSessionKey) {
  throw new Error("UGV_MQTT_TEST_DATABASE_URL, UGV_MQTT_INGEST_STATUS_URL, UGV_MQTT_HARNESS_CLIENT_ID and UGV_MQTT_HARNESS_TRACKER_SESSION_KEY are required");
}
if (!/^gowm_ugv_ingest_acceptance_[a-z0-9_]+$/u.test(new URL(databaseUrl).pathname.slice(1))) {
  throw new Error("consumer harness requires a disposable gowm_ugv_ingest_acceptance_* database");
}
const statusResponse = await fetch(statusUrl,{ signal: AbortSignal.timeout(5_000) });
if (!statusResponse.ok) throw new Error(`UGV ingest status returned HTTP ${statusResponse.status}`);
const status = await statusResponse.json() as Record<string,unknown>;
const subscriptions = status.subscriptions as Record<string,number> | undefined;
const conflicts = status.sourceQosConflicts as Record<string,number> | undefined;
for (const topic of UGV_AUTHORITY_TOPICS) {
  if (subscriptions?.[topic] !== 1) throw new Error(`consumer harness lacks QoS1 SUBACK for ${topic}`);
  if ((conflicts?.[topic] ?? 0) !== 0) throw new Error(`consumer harness observed source QoS conflict for ${topic}`);
}

const pool = new pg.Pool({ connectionString: databaseUrl,max: 1 });
try {
  const counts = await pool.query<{ topic: string; messages: number; dead_letters: number }>(
    `SELECT i.topic,count(*)::int AS messages,
            count(*) FILTER (WHERE i.processing_state='DEAD_LETTER')::int AS dead_letters
       FROM ugv_ingest.inbox_message i JOIN ugv_ingest.mqtt_session s USING(session_id)
      WHERE s.client_id=$1 GROUP BY i.topic ORDER BY i.topic`,[clientId]
  );
  const byTopic = Object.fromEntries(counts.rows.map((row) => [row.topic,{ messages: row.messages,deadLetters: row.dead_letters }]));
  const expectedTopicCounts: Record<string,number> = {
    "/ugv/gnss": 4,"/ugv/speed": 3,"status/ugv": 2,"/ugv/mission_state": 5,
    "/ugv/area_recon/status": 9,"/ugv/area_recon/targets": 6,"/ugv/area_recon/exception": 1
  };
  for (const topic of UGV_AUTHORITY_TOPICS) {
    if (byTopic[topic]?.messages !== expectedTopicCounts[topic]) {
      throw new Error(`consumer harness expected ${expectedTopicCounts[topic]} durable inbox rows for ${topic}, got ${byTopic[topic]?.messages ?? 0}`);
    }
  }
  if (byTopic["/ugv/gnss"]?.deadLetters !== 1) throw new Error("consumer harness expected exactly one explainable invalid GNSS payload");
  const delivery = await pool.query<{ pending: number; dead: number; delivered: number }>(
    `SELECT count(*) FILTER (WHERE o.delivery_state='PENDING')::int AS pending,
            count(*) FILTER (WHERE o.delivery_state='DEAD_LETTER')::int AS dead,
            count(*) FILTER (WHERE o.delivery_state='DELIVERED')::int AS delivered
       FROM ugv_ingest.outbox_message o JOIN ugv_ingest.inbox_message i ON i.message_id=o.inbox_message_id
       JOIN ugv_ingest.mqtt_session s ON s.session_id=i.session_id WHERE s.client_id=$1`,[clientId]
  );
  if (delivery.rows[0]?.pending !== 0 || delivery.rows[0]?.dead !== 0 || Number(delivery.rows[0]?.delivered ?? 0) < 1) {
    throw new Error(`consumer harness outbox is not drained: ${JSON.stringify(delivery.rows[0] ?? {})}`);
  }
  const eventCounts = await pool.query<{ event_type: string; count: number }>(
    `SELECT event.event_type,count(*)::int AS count
       FROM operational_task_event event
       JOIN ugv_ingest.outbox_message outbox ON outbox.idempotency_key=event.event_id
       JOIN ugv_ingest.inbox_message inbox ON inbox.message_id=outbox.inbox_message_id
       JOIN ugv_ingest.mqtt_session session ON session.session_id=inbox.session_id
      WHERE session.client_id=$1 AND event.source_authority IN ('/ugv/mission_state','/ugv/area_recon/status')
      GROUP BY event.event_type ORDER BY event.event_type`,[clientId]
  );
  const expectedEvents = ["EXECUTION_STARTED_OBSERVED","EXECUTION_PAUSED_OBSERVED","EXECUTION_RESUMED_OBSERVED","CONTROL_COMPLETED_REPORTED"];
  for (const eventType of expectedEvents) {
    if (Number(eventCounts.rows.find((row) => row.event_type === eventType)?.count ?? 0) < 2) {
      throw new Error(`consumer harness lacks separate chassis/recon ${eventType} events`);
    }
  }
  const forbiddenMirrorEvents = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM operational_task_event event
       JOIN ugv_ingest.outbox_message outbox ON outbox.idempotency_key=event.event_id
       JOIN ugv_ingest.inbox_message inbox ON inbox.message_id=outbox.inbox_message_id
       JOIN ugv_ingest.mqtt_session session ON session.session_id=inbox.session_id
      WHERE session.client_id=$1 AND event.source_authority NOT IN ('/ugv/mission_state','/ugv/area_recon/status')`,[clientId]
  );
  if (forbiddenMirrorEvents.rows[0]?.count !== 0) throw new Error("mirror/non-authority stream generated an operational event");
  const brokenProvenance = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM operational_task_event event
       JOIN ugv_ingest.outbox_message outbox ON outbox.idempotency_key=event.event_id
       JOIN ugv_ingest.inbox_message inbox ON inbox.message_id=outbox.inbox_message_id
       JOIN ugv_ingest.mqtt_session session ON session.session_id=inbox.session_id
      WHERE session.client_id=$1 AND source_authority IN ('/ugv/mission_state','/ugv/area_recon/status') AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(event.provenance) evidence
        JOIN world_observation observation ON observation.observation_id=evidence->>'evidenceId'
      )`,[clientId]
  );
  if (brokenProvenance.rows[0]?.count !== 0) throw new Error("operational event lacks a persisted triggering observation");
  const vehicleTracklet = await pool.query<{ srid: number; sample_count: number }>(
    `SELECT ST_SRID(version.start_position) AS srid,version.sample_count
      FROM mobility_tracklet tracklet JOIN mobility_tracklet_head head USING(tracklet_id)
       JOIN mobility_tracklet_version version ON version.tracklet_version_id=head.current_version_id
      WHERE tracklet.source_local_target_id='ugv' AND tracklet.analysis_space_key='airport-utm48n'
        AND tracklet.tracker_session_key=$1
      ORDER BY version.created_at DESC LIMIT 1`,[trackerSessionKey]
  );
  if (vehicleTracklet.rows[0]?.srid !== 32648 || Number(vehicleTracklet.rows[0]?.sample_count ?? 0) < 2) {
    throw new Error("consumer harness did not build the UGV EPSG:32648 MobilityDB tracklet");
  }
  const frameMeanings = await pool.query<{ meaning: string }>(
    `SELECT DISTINCT observation.value#>>'{reconFrame,frameMeaning}' AS meaning FROM world_observation observation
       JOIN ugv_ingest.outbox_message outbox ON outbox.idempotency_key=observation.observation_id
       JOIN ugv_ingest.inbox_message inbox ON inbox.message_id=outbox.inbox_message_id
       JOIN ugv_ingest.mqtt_session session ON session.session_id=inbox.session_id
      WHERE session.client_id=$1 AND observation.observation_type='UGV_RECON_TARGET_FRAME'`,[clientId]
  );
  for (const meaning of ["REPORTED_TARGET_COUNT_ZERO","UNOBSERVABLE_DURING_CAMERA_FAULT","CACHE_CLEAR_FRAME"]) {
    if (!frameMeanings.rows.some((row) => row.meaning === meaning)) throw new Error(`missing empty target frame meaning ${meaning}`);
  }
  const cameraFaultCandidates = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM world_observation observation
       JOIN ugv_ingest.outbox_message outbox ON outbox.idempotency_key=observation.observation_id
       JOIN ugv_ingest.inbox_message inbox ON inbox.message_id=outbox.inbox_message_id
       JOIN ugv_ingest.mqtt_session session ON session.session_id=inbox.session_id
      WHERE session.client_id=$1 AND observation.observation_type='UGV_RECON_TARGET'
        AND observation.quality_flags @> ARRAY['CAMERA_FAULT_ACTIVE_AT_INGEST']::text[]
        AND NOT EXISTS (SELECT 1 FROM projection_queue queue WHERE queue.observation_id=observation.observation_id)`,[clientId]
  );
  if (Number(cameraFaultCandidates.rows[0]?.count ?? 0) < 1) throw new Error("camera-fault target was not retained as an unprojected candidate");
  const targetEvidence = await pool.query<{ targets: number; complete: number }>(
    `SELECT count(*)::int AS targets,
            count(*) FILTER (WHERE
              EXISTS (SELECT 1 FROM measurement m WHERE m.observation_id=observation.observation_id AND m.measurement_key='position')
              AND EXISTS (SELECT 1 FROM measurement m WHERE m.observation_id=observation.observation_id AND m.measurement_key='velocity-enu')
              AND EXISTS (SELECT 1 FROM measurement m WHERE m.observation_id=observation.observation_id AND m.measurement_key='confidence')
              AND EXISTS (SELECT 1 FROM measurement m WHERE m.observation_id=observation.observation_id AND m.measurement_key='threat')
              AND observation.value#>>'{target,iff}' IS NOT NULL)::int AS complete
       FROM world_observation observation
       JOIN ugv_ingest.outbox_message outbox ON outbox.idempotency_key=observation.observation_id
       JOIN ugv_ingest.inbox_message inbox ON inbox.message_id=outbox.inbox_message_id
       JOIN ugv_ingest.mqtt_session session ON session.session_id=inbox.session_id
      WHERE session.client_id=$1 AND observation.observation_type='UGV_RECON_TARGET'`,[clientId]
  );
  if (!targetEvidence.rows[0]?.targets || targetEvidence.rows[0].targets !== targetEvidence.rows[0].complete) {
    throw new Error(`target evidence is incomplete: ${JSON.stringify(targetEvidence.rows[0] ?? {})}`);
  }
  const exceptionNamespaces = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM world_observation observation
       JOIN ugv_ingest.outbox_message outbox ON outbox.idempotency_key=observation.observation_id
       JOIN ugv_ingest.inbox_message inbox ON inbox.message_id=outbox.inbox_message_id
       JOIN ugv_ingest.mqtt_session session ON session.session_id=inbox.session_id
      WHERE session.client_id=$1 AND observation.observation_type='UGV_RECON_EXCEPTION'
        AND observation.value#>>'{exception,errorNamespace}'='AREA_RECON_RUNTIME'`,[clientId]
  );
  if (exceptionNamespaces.rows[0]?.count !== 1) throw new Error("recon exception namespace was not preserved");
  const currentProjection = await pool.query<{ count: number }>(
    `SELECT count(DISTINCT state.object_id)::int AS count FROM world_object_state state
       JOIN ugv_ingest.outbox_message outbox ON outbox.idempotency_key=state.source_observation_id
       JOIN ugv_ingest.inbox_message inbox ON inbox.message_id=outbox.inbox_message_id
       JOIN ugv_ingest.mqtt_session session ON session.session_id=inbox.session_id
      WHERE session.client_id=$1`,[clientId]
  );
  if (Number(currentProjection.rows[0]?.count ?? 0) < 5) throw new Error("consumer harness did not produce the expected current projections");
  process.stdout.write(`${JSON.stringify({ status: "PASS_CONSUMER_HARNESS_NOT_SOURCE_ACCEPTANCE",
    marker: "UGV_MQTT_CONSUMER_HARNESS",topics: byTopic,outbox: delivery.rows[0],events: eventCounts.rows,
    vehicleTracklet: vehicleTracklet.rows[0],targetEvidence: targetEvidence.rows[0],currentProjection: currentProjection.rows[0],
    sourceContractAuthority: "NOT_ASSERTED" })}\n`);
} finally {
  await pool.end();
}
