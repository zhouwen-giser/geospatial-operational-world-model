# 公共九表数据字典

所有身份列均无全库默认设备。详见正式 078 迁移中的 CHECK/UNIQUE/FK 和原生 overlay。

## gowm_device.device

|字段|类型|可空|默认值|
|---|---|---|---|
|device_id|text|NO||
|data_scope_key|text|NO||
|identifier_namespace|text|NO||
|device_identifier|text|NO||
|device_name|text|NO||
|device_type|text|NO||
|enabled|boolean|NO|true|
|properties|jsonb|NO|'{}'::jsonb|
|created_at|timestamp with time zone|NO|now()|
|updated_at|timestamp with time zone|NO|now()|

## gowm_device.device_service_binding

|字段|类型|可空|默认值|
|---|---|---|---|
|binding_id|uuid|NO|gen_random_uuid()|
|data_scope_key|text|NO||
|device_id|text|NO||
|binding_role|text|NO|'PRIMARY'::text|
|smpp_service_key|text|NO||
|provider_id|text|NO||
|resource_id|text|NO||
|sdar_service_key|text|YES||
|agent_profile_id|text|YES||
|sdar_mcp_server_id|text|YES||
|valid_from|timestamp with time zone|NO|now()|
|valid_to|timestamp with time zone|YES||
|created_at|timestamp with time zone|NO|now()|

## gowm_device.device_stream

|字段|类型|可空|默认值|
|---|---|---|---|
|stream_id|uuid|NO|gen_random_uuid()|
|data_scope_key|text|NO||
|device_id|text|NO||
|endpoint_id|uuid|NO||
|stream_key|text|NO||
|topic_filter|text|NO||
|identity_mode|text|NO||
|identity_rule|jsonb|NO||
|message_profile|text|NO||
|mapper_config|jsonb|NO|'{}'::jsonb|
|datastream_key|text|NO||
|qos|smallint|NO|1|
|enabled|boolean|NO|true|
|created_at|timestamp with time zone|NO|now()|
|updated_at|timestamp with time zone|NO|now()|

## gowm_device.mqtt_endpoint

|字段|类型|可空|默认值|
|---|---|---|---|
|endpoint_id|uuid|NO|gen_random_uuid()|
|endpoint_key|text|NO||
|broker_url|text|NO||
|client_id_prefix|text|NO||
|credential_ref|text|YES||
|connection_options|jsonb|NO|'{}'::jsonb|
|enabled|boolean|NO|true|
|created_at|timestamp with time zone|NO|now()|
|updated_at|timestamp with time zone|NO|now()|

## gowm_task.target_binding

|字段|类型|可空|默认值|
|---|---|---|---|
|target_binding_id|uuid|NO|gen_random_uuid()|
|target_id|uuid|NO||
|device_id|text|NO||
|data_scope_key|text|NO||
|owner_domain|text|NO||
|owner_kind|text|NO||
|owner_key|jsonb|NO||
|usage_role|text|NO||
|target_purpose|text|NO||
|argument_path|text|NO||
|created_at|timestamp with time zone|NO|now()|

## gowm_task.target_geometry

|字段|类型|可空|默认值|
|---|---|---|---|
|target_id|uuid|NO|gen_random_uuid()|
|target_group_id|uuid|NO||
|revision|integer|NO||
|data_scope_key|text|NO||
|source_domain|text|NO||
|source_record_identity|jsonb|NO||
|geometry_kind|text|NO||
|native_geometry|jsonb|NO||
|native_crs|text|NO||
|geometry_wgs84|USER-DEFINED|YES||
|normalization_state|text|NO||
|transform_info|jsonb|NO|'{}'::jsonb|
|supersedes_target_id|uuid|YES||
|created_at|timestamp with time zone|NO|now()|

## gowm_execution.device_mission

|字段|类型|可空|默认值|
|---|---|---|---|
|mission_instance_id|uuid|NO|gen_random_uuid()|
|device_id|text|NO||
|data_scope_key|text|NO||
|mission_channel|text|NO||
|world_object_id|text|YES||
|created_by|text|NO||
|created_at|timestamp with time zone|NO|now()|

## gowm_execution.execution_mission_link

|字段|类型|可空|默认值|
|---|---|---|---|
|link_id|uuid|NO|gen_random_uuid()|
|device_id|text|NO||
|data_scope_key|text|NO||
|binding_id|uuid|NO||
|mcp_task_id|uuid|YES||
|provider_execution_id|text|NO||
|provider_task_record_id|text|NO||
|provider_dispatch_step_id|text|NO||
|mission_instance_id|uuid|YES||
|relation_kind|text|NO||
|link_state|text|NO||
|source_system_key|text|NO||
|idempotency_key|text|NO||
|source_evidence_ref|jsonb|NO||
|unresolved_native_identity|jsonb|YES||
|created_at|timestamp with time zone|NO|now()|
|updated_at|timestamp with time zone|NO|now()|

## gowm_execution.mission_identity

|字段|类型|可空|默认值|
|---|---|---|---|
|identity_id|uuid|NO|gen_random_uuid()|
|mission_instance_id|uuid|NO||
|device_id|text|NO||
|mission_channel|text|NO||
|authority_key|text|NO||
|identity_kind|text|NO||
|native_session_key|text|NO||
|native_mission_id|text|NO||
|evidence_ref|jsonb|NO||
|created_at|timestamp with time zone|NO|now()|
