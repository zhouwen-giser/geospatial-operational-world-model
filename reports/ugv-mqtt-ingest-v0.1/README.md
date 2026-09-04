# UGV MQTT ingest v0.1 evidence

Overall status: `BLOCKED_SOURCE_CONTRACT_CONFLICT`.

Baseline GOWM SHA is `8eeb3cfc3dad19e0d4480a6b22cfd43e7b6cd89b`; work is isolated on `codex/ugv-mqtt-canonical-ingest-v0.1`. The source checkout remains tracked-clean at `c10620572a7e1f0a881a8bd97198618bcf5d3d5a`; its pre-existing untracked ZIP was untouched.

Consumer-side code, migration 070, statePatch, sourceGeometry-only POSITION, EPSG:32648 server projection, deterministic mapping, packet lifecycle, inbox/outbox and health/metrics endpoints are implemented. Contract/unit tests and a real PostgreSQL 18.6 projection test pass.

Final acceptance cannot pass because the generated source Schema directory is absent, source `bridge_config.yaml` declares `status/ugv1` rather than the fixed `status/ugv`, and both source configuration and live broker evidence show `/ugv/speed` at QoS 0. MQTT subscription QoS 1 is only a maximum grant; it cannot upgrade a QoS 0 PUBLISH, which has no PUBACK. No source files were changed, as required.

To unblock, the source owner must reconcile and regenerate the machine contract and provide a source-authorized QoS 1 speed stream at the fixed topic. That is external coordination, not an authorized change in this repository. Afterward rerun the real crash, outage/restart, seven-stream E2E, tracklet/timeline, and 100 msg/s for 10 minutes gates.
