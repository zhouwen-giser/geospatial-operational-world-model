import { UGV_AUTHORITY_TOPICS } from "../../packages/integrations/ugv-mqtt-ingest-core/src/contracts.js";

const url = process.env.UGV_MQTT_INGEST_STATUS_URL;
if (!url) throw new Error("UGV_MQTT_INGEST_STATUS_URL is required for the real seven-stream E2E gate");
const response = await fetch(url,{ signal: AbortSignal.timeout(5000) });
if (!response.ok) throw new Error(`UGV ingest status returned HTTP ${response.status}`);
const status = await response.json() as Record<string,unknown>;
const subscriptions = status.subscriptions as Record<string,number> | undefined;
const conflicts = status.sourceQosConflicts as Record<string,number> | undefined;
const missing = UGV_AUTHORITY_TOPICS.filter((topic) => subscriptions?.[topic] !== 1);
const qosConflicts = UGV_AUTHORITY_TOPICS.filter((topic) => (conflicts?.[topic] ?? 0) > 0);
if (missing.length || qosConflicts.length) throw new Error(`BLOCKED_SOURCE_CONTRACT_CONFLICT missing=${missing.join(",")} qos=${qosConflicts.join(",")}`);
process.stdout.write(`${JSON.stringify({ status: "PASS",marker: "UGV_MQTT_SEVEN_STREAM_E2E",topics: UGV_AUTHORITY_TOPICS })}\n`);
