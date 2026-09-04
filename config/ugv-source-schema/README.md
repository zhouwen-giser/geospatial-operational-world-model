This directory is only a safe Compose bind-mount placeholder.

The `ugv-mqtt` profile must set `UGV_EQUIPMENT_SCHEMA_DIR` to the absolute,
read-only generated `doc/equipment/schema` directory containing
`mqtt_topics.json`, `mcp_ugv.json`, and `error_codes.json`. The adapter refuses
to become ready when those source-owned contract files are absent or invalid.
