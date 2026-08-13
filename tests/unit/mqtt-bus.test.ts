import { describe, expect, it } from "vitest";
import { decodeWorldEvent, observationTopic, worldEventTopic } from "../../packages/runtime/src/bus.js";
import type { WorldEvent } from "../../packages/world-model-core/src/types.js";

describe("MQTT topic and envelope contract", () => {
  it("maps observation and event envelopes to stable hierarchical topics", () => {
    expect(observationTopic({ subject: { type: "UGV", id: "ugv-1" }, observationType: "position" }))
      .toBe("gowm/observation/UGV/position");
    expect(worldEventTopic({ eventType: "ObjectEnteredArea", subject: { type: "UGV", id: "ugv-1" } }))
      .toBe("gowm/event/ObjectEnteredArea/UGV");
  });

  it("decodes a valid world event and rejects incomplete payloads", () => {
    const event: WorldEvent = {
      eventId: "8ba6cff9-6b20-4815-88df-16f52bdbd75b",
      eventType: "ObjectMoved",
      subject: { type: "UGV", id: "ugv-1" },
      timestamp: "2026-08-12T00:00:00.000Z",
      worldVersion: 42,
      correlationId: "corr-1",
      causationId: "obs-1",
      payload: {},
      schemaVersion: "1.0"
    };
    expect(decodeWorldEvent(Buffer.from(JSON.stringify(event)))).toEqual(event);
    expect(() => decodeWorldEvent(Buffer.from("{}"))).toThrow(/required event envelope/);
  });
});
