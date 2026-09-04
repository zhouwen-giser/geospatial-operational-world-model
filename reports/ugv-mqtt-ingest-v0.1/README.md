# UGV MQTT ingest v0.1 evidence

Overall status: `BLOCKED_SOURCE_CONTRACT_CONFLICT`.

Baseline GOWM SHA is `8eeb3cfc3dad19e0d4480a6b22cfd43e7b6cd89b`; work is isolated on `codex/ugv-mqtt-canonical-ingest-v0.1`. The source checkout remains tracked-clean at `c10620572a7e1f0a881a8bd97198618bcf5d3d5a`; its pre-existing untracked ZIP was untouched.

Consumer-side code, migration 070, statePatch, sourceGeometry-only POSITION, EPSG:32648 server projection, deterministic mapping, packet lifecycle, inbox/outbox and health/metrics endpoints are implemented. The ACK-before-return boundary is a single atomic PostgreSQL statement, while bounded mapping/delivery concurrency is configurable in `.env.example`.

Consumer-only acceptance is PASS on disposable infrastructure: deliberate crash before PUBACK recovered exactly one durable message; API outage, PostgreSQL pause, broker restart, adapter restart and Projection Worker restart all converged without duplicate canonical output. The seven-stream harness produced 28 delivered inputs, one retained-policy ignore, one intentional poison dead letter and 37 delivered outbox records. Projection rebuilt/finalized seven tracklets, including a three-sample EPSG:32648 vehicle tracklet, and projected two task intervals. A 600.012-second run published and durably received all 66,000 messages at 109.998 msg/s with zero dead letters and zero final backlog; this is explicitly test-harness evidence, not source authority.

Final acceptance cannot pass because the generated source Schema directory is absent, source `bridge_config.yaml` declares `status/ugv1` rather than the fixed `status/ugv`, and both source configuration and live broker evidence show `/ugv/speed` at QoS 0. MQTT subscription QoS 1 is only a maximum grant; it cannot upgrade a QoS 0 PUBLISH, which has no PUBACK. No source files were changed, as required.

The final 30-second read-only source probe observed GNSS 599/QoS1, speed 300/QoS0, mission 30/QoS1 and recon status 600/QoS1; the other three fixed topics were not observed within that window. To unblock final source acceptance, the source owner must reconcile and regenerate the machine contract and provide a source-authorized QoS 1 speed stream at the fixed topic. That is external coordination, not an authorized change in this repository. Once corrected, rerun source-backed seven-stream and crash/PUBACK acceptance; the consumer implementation gates do not need to be reinterpreted as source evidence.
