import { readFile } from "node:fs/promises";
import { describe,expect,it } from "vitest";

describe("UGV MQTT QoS1 durable acknowledgement architecture",() => {
  it("binds packet lifecycle to session, packet id and generation",async () => {
    const migration = await readFile("database/migrations/070_ugv_mqtt_ingest_runtime.sql","utf8");
    expect(migration).toContain("PRIMARY KEY (session_id,packet_id)");
    expect(migration).toContain("UNIQUE (session_id,packet_id,packet_generation)");
    expect(migration).toContain("puback_sent_at timestamptz");
  });

  it("uses MQTT 5 custom acknowledgement handling before PUBACK",async () => {
    const app = await readFile("services/ugv-mqtt-ingest/src/app.ts","utf8");
    const repository = await readFile("services/ugv-mqtt-ingest/src/repository.ts","utf8");
    expect(app.indexOf("customHandleAcks")).toBeLessThan(app.indexOf("done(0)"));
    expect(app).toContain("repository.accept(sessionId,topic,payload,packet,receivedAt)");
    expect(app).toContain('packet.cmd === "puback"');
    expect(repository).toContain("packet identifier reused with different payload before PUBACK");
    expect(repository).not.toContain("UNIQUE (topic,payload_sha256)");
  });
});
