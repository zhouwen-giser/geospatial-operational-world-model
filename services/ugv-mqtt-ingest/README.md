# UGV MQTT canonical ingest

This optional `ugv-mqtt` Compose profile is a consumer-only adapter for the
seven authoritative UGV streams. It never publishes to the source broker.

The adapter uses MQTT 5 with a stable client ID, `clean=false`, a persistent
session, and an explicit receive window. For QoS 1, it commits the immutable
raw PUBLISH and packet generation in PostgreSQL before allowing PUBACK. Mapping
state, sampling cursors, and HTTP outbox bodies are also durable. Delivery uses
deterministic observation/event IDs; this supports idempotent redelivery but is
not an exactly-once claim.

## Required source contract

`UGV_EQUIPMENT_SCHEMA_DIR` must be an absolute, read-only directory containing
the source-generated `mqtt_topics.json`, `mcp_ugv.json`, and
`error_codes.json`. Local transitive JSON Schema references are hash-locked;
remote references, symlinks, path escapes, missing topics, and merged MCP/MQTT
error-code domains fail closed. The adapter subscribes to exactly:

- `/ugv/gnss`
- `/ugv/speed`
- `status/ugv`
- `/ugv/mission_state`
- `/ugv/area_recon/status`
- `/ugv/area_recon/targets`
- `/ugv/area_recon/exception`

All seven are requested at QoS 1. A source QoS 0 delivery is durably audited
but marks the source contract unhealthy because commit-before-ACK cannot be
provided for QoS 0.

## Configuration and operation

Copy the documented UGV block from `.env.example`. Secrets are accepted only
through absolute regular-file paths; broker/API URLs may not embed credentials.
The airport analysis space is the migration-registered `airport-utm48n`
(EPSG:32648). `UGV_WORLD_EPOCH` and `UGV_TRACKER_SESSION_KEY` are mandatory.

Start with `docker compose --profile ugv-mqtt up -d`. Operational endpoints are
`/health/live`, `/health/ready`, `/metrics`, and `/v1/ingest/status` on
`UGV_MQTT_INGEST_PORT`. Readiness requires a writable database, source schema
lock, broker connection, all seven QoS 1 SUBACKs, a healthy worker, and no
observed source QoS conflict. A reachable but temporarily failing GOWM API is
reported as recoverable degradation while the durable outbox retries.

`UGV_MQTT_PROCESS_CONCURRENCY` and `UGV_MQTT_DELIVERY_CONCURRENCY` bound the
independent mapping and outbox workers (default `8` each, maximum `64`). QoS 1
acceptance itself remains serialized by MQTT.js, so migration 070 performs the
packet-slot, backpressure, and inbox decision in one atomic database function;
PUBACK is still released only after that statement commits.

Use a deployment-specific Compose override to mount password/TLS files. Do not
put credentials, raw payloads, authorization headers, or large target details
in logs or evidence reports.

`UGV_MQTT_FAULT_EXIT_AFTER_INBOX_COMMITS` is a destructive, test-only crash
injection point between durable inbox commit and PUBACK. Leave it unset during
normal operation; a harness may set it for the first process and must restart
without it to prove broker DUP recovery.
