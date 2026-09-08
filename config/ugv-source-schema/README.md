# UGV source contract snapshot

The three generated JSON contracts and SOURCE_LOCK.json are copied byte-for-byte
from the existing GDPS deployment snapshot, originally exported from isr-simulation
revision c10620572a7e1f0a881a8bd97198618bcf5d3d5a. The lock records provenance,
generator versions and file checksums. This is a source contract snapshot, not test data.

New installations bind this directory read-only by default. Existing deployments keep
UGV_EQUIPMENT_SCHEMA_DIR unchanged. Configure UGV_MQTT_URL for the actual broker;
these contracts do not certify the availability or QoS of a broker.
