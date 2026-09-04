# UGV MQTT reliable ingest architecture

Status: `BLOCKED` by the immutable source contract, while the consumer-side implementation is present.

The adapter uses MQTT 5 with `clean=false`, a stable client ID and session expiry. It subscribes to exactly the seven authority topics at requested QoS 1. MQTT.js `customHandleAcks` commits the raw bytes and packet lifecycle to PostgreSQL before permitting PUBACK. A `packetsend` PUBACK closes the `(session, packet-id, generation)` slot; completed identifiers may be reused, while an incomplete identifier with different bytes is a protocol conflict.

Mapping is a pure core package, separate from the MQTT callback. Durable stream cursors isolate chassis `0..5` from recon `1..13/99`, suppress mirror events, carry mission/recon epochs and command ACK state, and create deterministic `ugvobs_…` / `ugvevt_…` identifiers. HTTP delivery is a retrying transactional outbox. No end-to-end exactly-once claim is made.

The source repository currently has no generated `doc/equipment/schema` directory, and its immutable bridge configuration publishes `/ugv/speed` at QoS 0. A QoS 0 PUBLISH has no PUBACK and therefore cannot satisfy ACK-after-durable-commit. The adapter audits such messages and makes readiness false instead of misrepresenting reliability.
