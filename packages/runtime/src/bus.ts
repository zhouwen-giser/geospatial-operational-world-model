import { randomUUID } from "node:crypto";
import { connectAsync, type MqttClient } from "mqtt";
import type { ObservationEnvelope, WorldEvent } from "../../world-model-core/src/types.js";
import { loadConfig } from "../../world-model-core/src/config.js";

const EVENT_TOPIC_FILTER = "gowm/event/#";
type EventHandler = (event: WorldEvent) => void | Promise<void>;

export interface WorldEventSubscription {
  unsubscribe(): void;
}

/**
 * MQTT is the live, at-least-once delivery plane. PostgreSQL world_event and
 * world_observation remain the durable replay sources; MQTT is deliberately
 * not treated as an authoritative event log.
 */
export class WorldEventBus {
  private client: MqttClient | undefined;
  private connectionAttempt: Promise<void> | undefined;
  private readonly eventHandlers = new Set<EventHandler>();
  private eventTopicSubscribed = false;

  async connect(): Promise<void> {
    if (this.client?.connected) return;
    if (this.connectionAttempt) return this.connectionAttempt;
    this.connectionAttempt = this.openConnection();
    try {
      await this.connectionAttempt;
    } finally {
      this.connectionAttempt = undefined;
    }
  }

  private async openConnection(): Promise<void> {
    if (this.client) {
      await this.client.endAsync(true).catch(() => undefined);
      this.eventTopicSubscribed = false;
    }
    const config = loadConfig();
    const client = await connectAsync(config.mqttUrl, {
      protocolVersion: 5,
      clean: true,
      clientId: `${safeTopicSegment(process.env.SERVICE_NAME ?? "gowm")}-${process.pid}-${randomUUID().slice(0, 8)}`,
      connectTimeout: config.mqttConnectTimeoutMs,
      reconnectPeriod: 1_000,
      keepalive: 30,
      properties: { sessionExpiryInterval: 0 }
    }, false);
    client.on("error", (error) => {
      process.stderr.write(`MQTT client error: ${error.message}\n`);
    });
    client.on("message", (_topic, payload) => {
      let event: WorldEvent;
      try {
        event = decodeWorldEvent(payload);
      } catch (error) {
        process.stderr.write(`discarded invalid MQTT world event: ${error instanceof Error ? error.message : String(error)}\n`);
        return;
      }
      for (const handler of this.eventHandlers) {
        Promise.resolve(handler(event)).catch((error: unknown) => {
          process.stderr.write(`MQTT event handler failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      }
    });
    this.client = client;
  }

  async publishObservation(observation: ObservationEnvelope): Promise<void> {
    await this.publish(observationTopic(observation), observation, observation.observationId);
  }

  async publishEvent(event: WorldEvent): Promise<void> {
    await this.publish(worldEventTopic(event), event, event.eventId);
  }

  async subscribeEvents(handler: EventHandler): Promise<WorldEventSubscription> {
    await this.connect();
    this.eventHandlers.add(handler);
    try {
      if (!this.eventTopicSubscribed) {
        await this.client!.subscribeAsync(EVENT_TOPIC_FILTER, { qos: 1 });
        this.eventTopicSubscribed = true;
      }
    } catch (error) {
      this.eventHandlers.delete(handler);
      throw error;
    }
    let active = true;
    return {
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.eventHandlers.delete(handler);
      }
    };
  }

  async drain(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.eventHandlers.clear();
    this.eventTopicSubscribed = false;
    if (client) await client.endAsync(false, { reasonCode: 0 });
  }

  private async publish(topic: string, value: unknown, messageId: string): Promise<void> {
    await this.connect();
    const config = loadConfig();
    await this.client!.publishAsync(topic, JSON.stringify(value), {
      qos: 1,
      retain: false,
      properties: {
        contentType: "application/json",
        payloadFormatIndicator: true,
        messageExpiryInterval: config.mqttMessageExpirySec,
        userProperties: { messageId, schemaVersion: "1.0" }
      }
    });
  }
}

export function observationTopic(observation: Pick<ObservationEnvelope, "subject" | "observationType">): string {
  return `gowm/observation/${safeTopicSegment(observation.subject.type)}/${safeTopicSegment(observation.observationType)}`;
}

export function worldEventTopic(event: Pick<WorldEvent, "eventType" | "subject">): string {
  return `gowm/event/${safeTopicSegment(event.eventType)}/${safeTopicSegment(event.subject.type)}`;
}

export function decodeWorldEvent(payload: Uint8Array): WorldEvent {
  const decoded = JSON.parse(Buffer.from(payload).toString("utf8")) as WorldEvent;
  if (!decoded || typeof decoded !== "object" || !decoded.eventId || !decoded.eventType || !decoded.subject) {
    throw new Error("missing required event envelope fields");
  }
  return decoded;
}

function safeTopicSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_");
}
