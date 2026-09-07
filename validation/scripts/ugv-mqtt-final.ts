import { readFile } from "node:fs/promises";

const report = JSON.parse(await readFile("reports/ugv-mqtt-ingest-v0.1/FINAL_ACCEPTANCE_REPORT.json","utf8")) as { status?: unknown; gates?: unknown[] };
if (report.status !== "PASS") throw new Error(`UGV MQTT final acceptance is ${String(report.status ?? "MISSING")}`);
process.stdout.write(`${JSON.stringify({ status: "PASS",marker: "UGV_MQTT_FINAL",gates: report.gates ?? [] })}\n`);
