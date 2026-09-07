import { readFile } from "node:fs/promises";

const path = process.env.UGV_MQTT_PERFORMANCE_EVIDENCE;
if (!path) throw new Error("UGV_MQTT_PERFORMANCE_EVIDENCE is required; synthetic performance evidence is forbidden");
const report = JSON.parse(await readFile(path,"utf8")) as Record<string,unknown>;
if (report.status !== "PASS" || Number(report.durationSeconds) < 600 || Number(report.rateMessagesPerSecond) < 100) {
  throw new Error("performance evidence does not prove 100 msg/s for 10 minutes");
}
process.stdout.write(`${JSON.stringify({ status: "PASS",marker: "UGV_MQTT_PERFORMANCE",evidence: path })}\n`);
