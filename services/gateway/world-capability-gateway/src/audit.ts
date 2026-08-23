import type { AuditEvent, AuditSink } from "./types.js";

export class MemoryAuditSink implements AuditSink {
  readonly #events: AuditEvent[] = [];

  async append(event: Readonly<AuditEvent>): Promise<void> {
    this.#events.push(structuredClone(event));
  }

  events(): readonly Readonly<AuditEvent>[] {
    return structuredClone(this.#events);
  }
}
