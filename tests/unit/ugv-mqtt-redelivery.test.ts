import { readFile } from "node:fs/promises";
import { describe,expect,it } from "vitest";

describe("UGV MQTT QoS1 durable acknowledgement architecture",() => {
  it("binds packet lifecycle to session, packet id and generation",async () => {
    const migration = await readFile("database/migrations/070_ugv_mqtt_ingest_runtime.sql","utf8");
    expect(migration).toContain("PRIMARY KEY (session_id,packet_id)");
    expect(migration).toContain("UNIQUE (session_id,packet_id,packet_generation)");
    expect(migration).toContain("puback_sent_at timestamptz");
    expect(migration).toContain("redelivery_count integer NOT NULL DEFAULT 0");
    expect(migration).toContain("destination_uri_kind text NOT NULL");
    expect(migration).toContain("request_headers jsonb NOT NULL");
  });

  it("uses MQTT 5 custom acknowledgement handling before PUBACK",async () => {
    const app = await readFile("services/ugv-mqtt-ingest/src/app.ts","utf8");
    const repository = await readFile("services/ugv-mqtt-ingest/src/repository.ts","utf8");
    const migration = await readFile("database/migrations/070_ugv_mqtt_ingest_runtime.sql","utf8");
    expect(app.indexOf("customHandleAcks")).toBeLessThan(app.indexOf("done(0)"));
    expect(app).toContain("waitForSession().then");
    expect(app).toContain("repository.accept(activeSessionId,topic,payload,packet,receivedAt)");
    expect(app.indexOf("beginSession();\n    const options")).toBeLessThan(app.indexOf("mqtt.connect(config.mqttUrl,options)"));
    expect(app).toContain("const connectionGeneration = currentSessionGeneration()");
    expect(app).toContain('client.on("reconnect",() => { beginSession(); })');
    expect(app).toContain('client.on("packetreceive",(packet) =>');
    expect(app).toContain('manualConnect: true');
    expect(app).not.toContain("return { ...config,mapperVersion");
    expect(app).toContain("pendingPubacks.clear()");
    expect(app).toContain('packet.cmd !== "puback"');
    expect(app).toContain("accepted.packetGeneration");
    expect(app).toContain("receiveMaximum: config.receiveMaximum");
    expect(repository).toContain("ugv_ingest.accept_message");
    expect(migration).toContain("packet identifier redelivery has different payload");
    expect(repository).toContain("generation=$3");
    expect(repository).toContain("immutable body hash mismatch");
    expect(repository).not.toContain("UNIQUE (topic,payload_sha256)");
  });
});
