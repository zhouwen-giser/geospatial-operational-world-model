-- Roots are mandatory; source migrations are installed into a new domain only.
ALTER TABLE ugv_smpp.provider_task ADD device_id text NOT NULL REFERENCES gowm_device.device,
 ADD gowm_binding_id uuid NOT NULL, ADD smpp_service_key text NOT NULL,
 ADD UNIQUE(device_id,task_id),
 ADD FOREIGN KEY(device_id,gowm_binding_id) REFERENCES gowm_device.device_service_binding(device_id,binding_id);
ALTER TABLE ugv_smpp.provider_task DROP CONSTRAINT provider_task_provider_id_external_execution_id_key;
DROP INDEX ugv_smpp.provider_task_external_execution_identity_unique;
CREATE UNIQUE INDEX provider_task_external_execution_identity_unique ON ugv_smpp.provider_task(device_id,smpp_service_key,provider_id,external_execution_id) WHERE external_execution_id IS NOT NULL;
ALTER TABLE ugv_smpp.admission_intent ADD device_id text NOT NULL REFERENCES gowm_device.device,
 ADD gowm_binding_id uuid NOT NULL, ADD smpp_service_key text NOT NULL,
 ADD UNIQUE(device_id,task_id), ADD FOREIGN KEY(device_id,gowm_binding_id) REFERENCES gowm_device.device_service_binding(device_id,binding_id);
ALTER TABLE ugv_smpp.idempotency_record ADD device_id text NOT NULL REFERENCES gowm_device.device, ADD smpp_service_key text NOT NULL;
ALTER TABLE ugv_smpp.idempotency_record DROP CONSTRAINT idempotency_record_pkey,
 ADD PRIMARY KEY(device_id,smpp_service_key,authorization_context_hash,operation_name,idempotency_key,execution_mode,simulation_key),
 ADD FOREIGN KEY(device_id,task_id) REFERENCES ugv_smpp.provider_task(device_id,task_id);
ALTER TABLE ugv_smpp.ugv_execution ADD device_id text NOT NULL REFERENCES gowm_device.device,
 ADD gowm_binding_id uuid NOT NULL, ADD smpp_service_key text NOT NULL, ADD mcp_task_id uuid,
 ADD source_session_key text,
 ADD UNIQUE(device_id,task_id), ADD UNIQUE(device_id,task_id,external_execution_id),
 ADD FOREIGN KEY(device_id,gowm_binding_id) REFERENCES gowm_device.device_service_binding(device_id,binding_id),
 ADD FOREIGN KEY(device_id,mcp_task_id) REFERENCES ugv_smpp.provider_task(device_id,task_id);
ALTER TABLE ugv_smpp.ugv_execution DROP CONSTRAINT ugv_execution_external_execution_id_key,
 ADD UNIQUE(device_id,smpp_service_key,external_execution_id);
DROP INDEX ugv_smpp.ugv_single_active_fire_execution;
CREATE UNIQUE INDEX ugv_single_active_fire_execution ON ugv_smpp.ugv_execution(device_id,resource_id)
 WHERE operation_name='vehicle_fire_weapon' AND state NOT IN ('SUCCEEDED','BUSINESS_FAILED','CANCELLED','TECHNICAL_FAILED');
ALTER TABLE ugv_smpp.ugv_mutation_journal ADD device_id text NOT NULL,
 ADD UNIQUE(device_id,task_id,step_id), ADD FOREIGN KEY(device_id,task_id) REFERENCES ugv_smpp.ugv_execution(device_id,task_id);
ALTER TABLE ugv_smpp.ugv_execution_command_ack ADD device_id text NOT NULL,
 ADD FOREIGN KEY(device_id,task_id) REFERENCES ugv_smpp.ugv_execution(device_id,task_id);
ALTER TABLE ugv_smpp.ugv_device_tool_call ADD device_id text NOT NULL REFERENCES gowm_device.device,
 ADD FOREIGN KEY(device_id,task_id) REFERENCES ugv_smpp.ugv_execution(device_id,task_id);
ALTER TABLE ugv_smpp.ugv_state_snapshot ADD device_id text NOT NULL REFERENCES gowm_device.device, ADD source_session_key text NOT NULL CHECK(source_session_key<>''), ADD channel text NOT NULL CHECK(channel<>''),
 DROP CONSTRAINT ugv_state_snapshot_pkey, ADD PRIMARY KEY(device_id,source_session_key,channel,revision);
CREATE INDEX device_snapshot_latest ON ugv_smpp.ugv_state_snapshot(device_id,source_session_key,channel,observed_at DESC,revision);
ALTER TABLE ugv_smpp.ugv_business_event_source_log DROP CONSTRAINT ugv_business_event_source_log_source_id_fkey;
ALTER TABLE ugv_smpp.ugv_business_event_source_state ADD device_id text NOT NULL REFERENCES gowm_device.device,
 DROP CONSTRAINT ugv_business_event_source_state_pkey, DROP CONSTRAINT ugv_business_event_source_state_source_stream_id_key,
 ADD PRIMARY KEY(device_id,source_id), ADD UNIQUE(device_id,source_stream_id);
ALTER TABLE ugv_smpp.ugv_business_event_source_log ADD device_id text NOT NULL,
 DROP CONSTRAINT ugv_business_event_source_log_pkey, DROP CONSTRAINT ugv_business_event_source_log_source_id_source_event_id_key,
 ADD PRIMARY KEY(device_id,source_id,source_sequence), ADD UNIQUE(device_id,source_id,source_event_id),
 ADD FOREIGN KEY(device_id,source_id) REFERENCES ugv_smpp.ugv_business_event_source_state(device_id,source_id);
ALTER TABLE ugv_smpp.runtime_lease ADD device_id text NOT NULL REFERENCES gowm_device.device,
 DROP CONSTRAINT runtime_lease_pkey, ADD PRIMARY KEY(device_id,lease_key);
ALTER TABLE ugv_smpp.ugv_diagnostic_lease ADD device_id text NOT NULL REFERENCES gowm_device.device,
 DROP CONSTRAINT ugv_diagnostic_lease_stable_operation_key_key, ADD UNIQUE(device_id,stable_operation_key);
ALTER TABLE ugv_smpp.outbox_event ADD device_id text NOT NULL REFERENCES gowm_device.device;
ALTER TABLE ugv_smpp.provider_ops_delivery ADD device_id text NOT NULL REFERENCES gowm_device.device;
ALTER TABLE gowm_execution.execution_mission_link
 ADD FOREIGN KEY(device_id,mcp_task_id) REFERENCES ugv_smpp.provider_task(device_id,task_id),
 ADD FOREIGN KEY(device_id,provider_task_record_id,provider_execution_id) REFERENCES ugv_smpp.ugv_execution(device_id,task_id,external_execution_id),
 ADD FOREIGN KEY(device_id,provider_task_record_id,provider_dispatch_step_id) REFERENCES ugv_smpp.ugv_mutation_journal(device_id,task_id,step_id);
