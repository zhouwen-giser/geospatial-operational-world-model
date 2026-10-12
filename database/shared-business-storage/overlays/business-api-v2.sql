-- Applied only after both native domains and read_model_v1 exist.
GRANT USAGE ON SCHEMA ugv_smpp,ugv_sdar,gowm_business_v1 TO gowm_business_api_owner;
GRANT SELECT ON ALL TABLES IN SCHEMA ugv_smpp,ugv_sdar,gowm_business_v1 TO gowm_business_api_owner;
GRANT UPDATE ON ugv_smpp.provider_task,ugv_smpp.ugv_mutation_journal,ugv_smpp.ugv_execution,
 ugv_sdar.agent_task,ugv_sdar.workflow_plan,ugv_sdar.remote_task_binding,
 ugv_sdar.workflow_instance,ugv_sdar.mcp_invocation TO gowm_business_api_owner;

-- The old SDAR invoker trigger could not read SMPP under its real login.
-- Keep its old function/overlay bytes; replace only the trigger in this new overlay.
CREATE FUNCTION gowm_business_api.validate_remote_canonical_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope_key text;
BEGIN
 IF NEW.canonical_mcp_task_id IS NULL THEN RETURN NEW; END IF;
 SELECT data_scope_key INTO scope_key FROM gowm_device.device WHERE device_id=NEW.device_id;
 PERFORM gowm_business_api.assert_device(scope_key,NEW.device_id,'SDAR');
 IF NOT EXISTS(SELECT 1 FROM ugv_smpp.provider_task m WHERE m.task_id=NEW.canonical_mcp_task_id
  AND m.device_id=NEW.device_id AND m.smpp_service_key=NEW.smpp_service_key) THEN
  RAISE EXCEPTION 'MCP_TASK_DEVICE_SERVICE_MISMATCH'; END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION gowm_business_api.validate_remote_canonical_identity() OWNER TO gowm_business_api_owner;
REVOKE ALL ON FUNCTION gowm_business_api.validate_remote_canonical_identity() FROM PUBLIC;
DROP TRIGGER gowm_remote_canonical ON ugv_sdar.remote_task_binding;
CREATE TRIGGER gowm_remote_canonical BEFORE INSERT OR UPDATE ON ugv_sdar.remote_task_binding
 FOR EACH ROW EXECUTE FUNCTION gowm_business_api.validate_remote_canonical_identity();

CREATE FUNCTION gowm_business_api.validate_owner(d text,domain text,kind text,k jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE keys text[]; actual text[]; valid boolean=false; scope_key text;
BEGIN
 SELECT data_scope_key INTO scope_key FROM gowm_device.device WHERE device_id=d;
 PERFORM gowm_business_api.assert_device(scope_key,d,domain);
 keys=CASE kind WHEN 'TASK' THEN ARRAY['taskId'] WHEN 'MCP_TASK' THEN ARRAY['taskId']
  WHEN 'PLAN_NODE' THEN ARRAY['nodeId','planId'] WHEN 'NODE_RUN' THEN ARRAY['bindingId','instanceId','nodeId','nodeRunId']
  WHEN 'PROVIDER_DISPATCH' THEN ARRAY['stepId','taskId'] END;
 IF jsonb_typeof(k) IS DISTINCT FROM 'object' OR keys IS NULL THEN RAISE EXCEPTION 'OWNER_KEY_INVALID'; END IF;
 SELECT array_agg(key ORDER BY key COLLATE "C") INTO actual FROM jsonb_object_keys(k) key;
 IF actual IS DISTINCT FROM keys OR EXISTS(SELECT 1 FROM jsonb_each(k) WHERE jsonb_typeof(value)<>'string' OR btrim(value#>>'{}')='')
 THEN RAISE EXCEPTION 'OWNER_KEY_INVALID'; END IF;
 IF domain='SDAR' AND kind='TASK' THEN
  PERFORM 1 FROM ugv_sdar.agent_task WHERE task_id=k->>'taskId' AND device_id=d FOR KEY SHARE; valid=FOUND;
 ELSIF domain='SMPP' AND kind='MCP_TASK' THEN
  PERFORM 1 FROM ugv_smpp.provider_task WHERE task_id::text=k->>'taskId' AND device_id=d FOR KEY SHARE; valid=FOUND;
 ELSIF domain='UGV_PROVIDER' AND kind='PROVIDER_DISPATCH' THEN
  PERFORM 1 FROM ugv_smpp.ugv_mutation_journal WHERE task_id=k->>'taskId' AND step_id=k->>'stepId' AND device_id=d FOR KEY SHARE; valid=FOUND;
 ELSIF domain='SDAR' AND kind='PLAN_NODE' THEN
  PERFORM 1 FROM ugv_sdar.workflow_plan p WHERE plan_id=k->>'planId' AND device_id=d
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.definition_json->'nodes') n WHERE n->>'id'=k->>'nodeId') FOR KEY SHARE; valid=FOUND;
 ELSIF domain='SDAR' AND kind='NODE_RUN' THEN
  PERFORM 1 FROM ugv_sdar.remote_task_binding WHERE binding_id=k->>'bindingId' AND workflow_instance_id=k->>'instanceId'
   AND workflow_node_id=k->>'nodeId' AND workflow_node_run_id=k->>'nodeRunId' AND device_id=d FOR KEY SHARE; valid=FOUND;
 END IF;
 IF NOT valid THEN RAISE EXCEPTION 'OWNER_NOT_FOUND_OR_DEVICE_MISMATCH'; END IF;
END $$;

CREATE FUNCTION gowm_business_api.write(p_operation text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d text=p->>'deviceId'; scope_key text=p->>'scope'; result jsonb; old jsonb;
 mission uuid; target uuid; normalized boolean; binding gowm_device.device_service_binding;
BEGIN
 IF p_operation='createTarget' THEN
  IF NOT gowm_business_api.is_deployment_admin() THEN
   IF d IS NULL THEN RAISE EXCEPTION 'DEVICE_ID_REQUIRED'; END IF;
   PERFORM gowm_business_api.assert_device(scope_key,d,p->>'sourceDomain');
  END IF;
  normalized=p->>'crs'='EPSG:4326';
  INSERT INTO gowm_task.target_geometry(target_group_id,revision,data_scope_key,source_domain,source_record_identity,
   geometry_kind,native_geometry,native_crs,geometry_wgs84,normalization_state,supersedes_target_id)
  VALUES((p->>'groupId')::uuid,(p->>'revision')::integer,scope_key,p->>'sourceDomain',p->'sourceIdentity',
   upper(p->'geometry'->>'type'),p->'geometry',p->>'crs',
   CASE WHEN normalized THEN public.ST_SetSRID(public.ST_GeomFromGeoJSON((p->'geometry')::text),4326) END,
   CASE WHEN normalized THEN 'NORMALIZED' ELSE 'NATIVE_ONLY' END,(p->>'supersedes')::uuid) RETURNING to_jsonb(target_geometry.*) INTO result;
 ELSIF p_operation='validateOwner' THEN
  PERFORM gowm_business_api.validate_owner(d,p->>'domain',p->>'kind',p->'key'); RETURN '{}'::jsonb;
 ELSE
  IF scope_key IS NULL THEN SELECT data_scope_key INTO scope_key FROM gowm_device.device WHERE device_id=d; END IF;
  PERFORM gowm_business_api.assert_device(scope_key,d);
  PERFORM set_config('gowm.data_scope_key',scope_key,true);
  IF p_operation='attachTargetToOwner' THEN
   PERFORM gowm_business_api.validate_owner(d,p->>'domain',p->>'kind',p->'key');
   INSERT INTO gowm_task.target_binding(target_id,device_id,data_scope_key,owner_domain,owner_kind,owner_key,usage_role,target_purpose,argument_path)
   VALUES((p->>'targetId')::uuid,d,scope_key,p->>'domain',p->>'kind',p->'key',p->>'role',p->>'purpose',p->>'argumentPath')
   ON CONFLICT(owner_domain,owner_kind,owner_key,usage_role,argument_path) DO NOTHING RETURNING to_jsonb(target_binding.*) INTO result;
   IF result IS NULL THEN
    SELECT to_jsonb(b.*) INTO result FROM gowm_task.target_binding b WHERE owner_domain=p->>'domain' AND owner_kind=p->>'kind'
     AND owner_key=p->'key' AND usage_role=p->>'role' AND argument_path=p->>'argumentPath';
    IF result->>'target_id' IS DISTINCT FROM p->>'targetId' OR result->>'device_id' IS DISTINCT FROM d
     OR result->>'target_purpose' IS DISTINCT FROM p->>'purpose' OR result->>'data_scope_key' IS DISTINCT FROM scope_key
    THEN RAISE EXCEPTION 'TARGET_BINDING_CONFLICT'; END IF;
   END IF;
  ELSIF p_operation='resolveRemoteTask' THEN
   PERFORM gowm_business_api.assert_device(scope_key,d,'SDAR');
   PERFORM 1 FROM ugv_smpp.provider_task WHERE device_id=d AND task_id=(p->>'mcpTaskId')::uuid AND smpp_service_key=p->>'service' FOR KEY SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'MCP_TASK_DEVICE_SERVICE_MISMATCH'; END IF;
   UPDATE ugv_sdar.remote_task_binding SET canonical_mcp_task_id=(p->>'mcpTaskId')::uuid
    WHERE device_id=d AND binding_id=p->>'bindingId' AND smpp_service_key=p->>'service'
     AND (canonical_mcp_task_id IS NULL OR canonical_mcp_task_id=(p->>'mcpTaskId')::uuid) RETURNING to_jsonb(remote_task_binding.*) INTO result;
   IF NOT FOUND THEN RAISE EXCEPTION 'REMOTE_IDENTITY_CONFLICT'; END IF;
  ELSIF p_operation='registerMissionIdentity' THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(d,p->>'channel',p->>'authority',p->>'session',p->>'nativeId')::text,718081));
   SELECT to_jsonb(i.*) INTO old FROM gowm_execution.mission_identity i WHERE device_id=d AND mission_channel=p->>'channel'
    AND authority_key=p->>'authority' AND native_session_key=p->>'session' AND native_mission_id=p->>'nativeId';
   IF old IS NOT NULL THEN
    IF (p->>'missionId' IS NOT NULL AND p->>'missionId'<>old->>'mission_instance_id') OR old->>'identity_kind'<>p->>'kind'
    THEN RAISE EXCEPTION 'MISSION_IDENTITY_CONFLICT'; END IF;
    RETURN old;
   END IF;
   mission=(p->>'missionId')::uuid;
   IF mission IS NULL THEN
    INSERT INTO gowm_execution.device_mission(device_id,data_scope_key,mission_channel,created_by)
     VALUES(d,scope_key,p->>'channel',p->>'authority') RETURNING mission_instance_id INTO mission;
   END IF;
   INSERT INTO gowm_execution.mission_identity(mission_instance_id,device_id,mission_channel,authority_key,identity_kind,native_session_key,native_mission_id,evidence_ref)
    VALUES(mission,d,p->>'channel',p->>'authority',p->>'kind',p->>'session',p->>'nativeId',p->'evidence') RETURNING to_jsonb(mission_identity.*) INTO result;
  ELSIF p_operation='linkExecutionToMission' THEN
   SELECT * INTO binding FROM gowm_device.device_service_binding WHERE binding_id=(p->>'bindingId')::uuid AND device_id=d AND data_scope_key=scope_key;
   IF NOT FOUND THEN RAISE EXCEPTION 'MISSION_BINDING_MISMATCH'; END IF;
   IF NOT EXISTS(SELECT 1 FROM ugv_smpp.ugv_execution e JOIN ugv_smpp.ugv_mutation_journal j ON j.task_id=e.task_id AND j.device_id=e.device_id
    WHERE e.device_id=d AND e.task_id=p->>'providerTaskId' AND e.external_execution_id=p->>'executionId' AND j.step_id=p->>'stepId'
     AND e.gowm_binding_id=binding.binding_id AND e.smpp_service_key=binding.smpp_service_key
     AND ((p->>'mcpTaskId' IS NULL) OR e.mcp_task_id=(p->>'mcpTaskId')::uuid))
   THEN RAISE EXCEPTION 'MISSION_EXECUTION_OWNER_MISMATCH'; END IF;
   result=jsonb_build_object('device_id',d,'data_scope_key',scope_key,'binding_id',p->>'bindingId','mcp_task_id',p->>'mcpTaskId',
    'provider_execution_id',p->>'executionId','provider_task_record_id',p->>'providerTaskId','provider_dispatch_step_id',p->>'stepId',
    'mission_instance_id',p->>'missionId','relation_kind',p->>'relation','link_state',p->>'state','source_system_key',p->>'source',
    'idempotency_key',p->>'idempotencyKey','source_evidence_ref',p->'evidence','unresolved_native_identity',p->'unresolved');
   INSERT INTO gowm_execution.execution_mission_link(device_id,data_scope_key,binding_id,mcp_task_id,provider_execution_id,provider_task_record_id,
    provider_dispatch_step_id,mission_instance_id,relation_kind,link_state,source_system_key,idempotency_key,source_evidence_ref,unresolved_native_identity)
   SELECT x.device_id,x.data_scope_key,x.binding_id,x.mcp_task_id,x.provider_execution_id,x.provider_task_record_id,x.provider_dispatch_step_id,
    x.mission_instance_id,x.relation_kind,x.link_state,x.source_system_key,x.idempotency_key,x.source_evidence_ref,x.unresolved_native_identity
   FROM jsonb_populate_record(NULL::gowm_execution.execution_mission_link,result) x
   ON CONFLICT(device_id,source_system_key,idempotency_key) DO NOTHING RETURNING to_jsonb(execution_mission_link.*) INTO old;
   IF old IS NULL THEN
    SELECT to_jsonb(l.*) INTO old FROM gowm_execution.execution_mission_link l WHERE device_id=d AND source_system_key=p->>'source' AND idempotency_key=p->>'idempotencyKey';
    IF old-'link_id'-'created_at'-'updated_at' IS DISTINCT FROM result THEN RAISE EXCEPTION 'MISSION_RECEIPT_CONFLICT'; END IF;
   END IF;
   result=old;
  ELSE RAISE EXCEPTION 'BUSINESS_OPERATION_UNSUPPORTED'; END IF;
 END IF;
 RETURN result;
END $$;

CREATE FUNCTION gowm_business_api.read(p_operation text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d text=p->>'deviceId'; scope_key text; result jsonb; lim integer=COALESCE((p->>'limit')::integer,50);
BEGIN
 IF lim<1 OR lim>200 THEN RAISE EXCEPTION 'LIMIT_INVALID'; END IF;
 SELECT data_scope_key INTO scope_key FROM gowm_device.device WHERE device_id=d;
 PERFORM gowm_business_api.assert_device(scope_key,d);
 -- Views have explicit device predicates below; no caller-supplied GUC is trusted.
 IF p_operation='tasks' THEN
  SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]') INTO result FROM (
   SELECT * FROM gowm_business_v1.sdar_tasks WHERE device_id=d
    AND ((p->'cursor'->>'createdAt') IS NULL OR (created_at,task_id)>((p->'cursor'->>'createdAt')::timestamptz,p->'cursor'->>'taskId'))
   ORDER BY created_at,task_id LIMIT lim) x;
 ELSIF p_operation='targets' THEN
  SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]') INTO result FROM (
   SELECT b.* FROM gowm_business_v1.task_target_geometries b WHERE b.device_id=d AND (
    (b.owner_kind='TASK' AND b.owner_key->>'taskId'=p->>'taskId') OR
    (b.owner_kind='PLAN_NODE' AND EXISTS(SELECT 1 FROM ugv_sdar.workflow_plan q WHERE q.device_id=d AND q.gowm_task_id=p->>'taskId' AND q.plan_id=b.owner_key->>'planId')) OR
    (b.owner_kind='NODE_RUN' AND EXISTS(SELECT 1 FROM ugv_sdar.remote_task_binding q WHERE q.device_id=d AND q.agent_task_id=p->>'taskId' AND q.binding_id=b.owner_key->>'bindingId')) OR
    EXISTS(SELECT 1 FROM gowm_business_v1.task_execution_lineage l WHERE l.device_id=d AND l.sdar_task_id=p->>'taskId'
     AND ((b.owner_kind='MCP_TASK' AND b.owner_key->>'taskId'=l.mcp_task_id::text) OR
     (b.owner_kind='PROVIDER_DISPATCH' AND b.owner_key->>'taskId'=l.provider_task_record_id AND b.owner_key->>'stepId'=l.dispatch_step_id))))
   ORDER BY b.created_at,b.target_binding_id) x;
 ELSIF p_operation='lineage' THEN
  SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]') INTO result FROM (SELECT * FROM gowm_business_v1.task_execution_lineage
   WHERE device_id=d AND sdar_task_id=p->>'taskId' ORDER BY plan_id,workflow_instance_id,workflow_node_run_id,mcp_task_id,provider_task_record_id,dispatch_step_id,link_id) x;
 ELSIF p_operation='steps' THEN
  SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]') INTO result FROM (SELECT * FROM gowm_business_v1.workflow_steps
   WHERE device_id=d AND task_id=p->>'taskId' ORDER BY plan_id,instance_id,sequence,workflow_node_run_id) x;
 ELSIF p_operation='mission' THEN
  SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]') INTO result FROM (
   SELECT m.mission_instance_id,l.link_state,q.*,COALESCE(q.missing_stage,CASE WHEN l.link_state='CONFLICTED' THEN 'CONFLICTED' ELSE 'NO_REMOTE_TASK' END) AS missing_stage
   FROM gowm_execution.device_mission m LEFT JOIN gowm_execution.execution_mission_link l ON l.mission_instance_id=m.mission_instance_id AND l.device_id=m.device_id
   LEFT JOIN gowm_business_v1.task_execution_lineage q ON q.link_id=l.link_id AND q.device_id=m.device_id WHERE m.device_id=d AND m.mission_instance_id=(p->>'id')::uuid) x;
 ELSIF p_operation='mcp' THEN
  SELECT to_jsonb(x) INTO result FROM gowm_business_v1.mcp_tasks x WHERE device_id=d AND task_id=(p->>'id')::uuid;
 ELSIF p_operation='snapshot' THEN
  SELECT to_jsonb(x) INTO result FROM ugv_smpp.ugv_state_snapshot x WHERE device_id=d AND source_session_key=p->>'source' AND channel=p->>'channel'
   ORDER BY observed_at DESC,revision DESC LIMIT 1;
 ELSE RAISE EXCEPTION 'BUSINESS_OPERATION_UNSUPPORTED'; END IF;
 RETURN result;
END $$;
ALTER FUNCTION gowm_business_api.validate_owner(text,text,text,jsonb) OWNER TO gowm_business_api_owner;
ALTER FUNCTION gowm_business_api.write(text,jsonb) OWNER TO gowm_business_api_owner;
ALTER FUNCTION gowm_business_api.read(text,jsonb) OWNER TO gowm_business_api_owner;
REVOKE ALL ON FUNCTION gowm_business_api.validate_owner(text,text,text,jsonb),gowm_business_api.write(text,jsonb),gowm_business_api.read(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_business_api.write(text,jsonb),gowm_business_api.read(text,jsonb) TO gowm_business_client;
