BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gowm_business_api_owner') THEN
  CREATE ROLE gowm_business_api_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gowm_business_api_owner' AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
  RAISE EXCEPTION 'BUSINESS_API_OWNER_CONFLICT';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gowm_business_client') THEN CREATE ROLE gowm_business_client NOLOGIN; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gowm_business_client' AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
  RAISE EXCEPTION 'BUSINESS_CLIENT_ROLE_CONFLICT'; END IF;
END $$;
CREATE SCHEMA gowm_business_api AUTHORIZATION gowm_business_api_owner;
CREATE TABLE gowm_business_api.service_authority (
 login_name name NOT NULL,
 data_scope_key text NOT NULL REFERENCES public.data_scope(scope_key),
 business_domain text NOT NULL CHECK(business_domain IN ('SMPP','SDAR')),
 smpp_service_key text NOT NULL CHECK(btrim(smpp_service_key)<>''),
 provider_id text NOT NULL CHECK(btrim(provider_id)<>''), resource_id text NOT NULL CHECK(btrim(resource_id)<>''),
 sdar_service_key text, sdar_mcp_server_id text, agent_profile_id text,
 allowed_device_ids text[] NOT NULL CHECK(cardinality(allowed_device_ids)>0),
 allow_unique_default boolean NOT NULL DEFAULT false,
 PRIMARY KEY(login_name,data_scope_key,smpp_service_key,provider_id,resource_id),
 CHECK((sdar_service_key IS NULL)=(sdar_mcp_server_id IS NULL))
);
REVOKE ALL ON gowm_business_api.service_authority FROM PUBLIC;
GRANT SELECT ON gowm_business_api.service_authority TO gowm_business_api_owner;
GRANT USAGE ON SCHEMA public,gowm_device,gowm_task,gowm_execution,gowm_reference_v1 TO gowm_business_api_owner;
GRANT SELECT ON gowm_device.device,public.world_object,public.world_reference_identity,
 public.world_reference_retirement,gowm_reference_v1.identity TO gowm_business_api_owner;
GRANT EXECUTE ON FUNCTION gowm_reference_v1.current_data_scope_key() TO gowm_business_api_owner;
-- Row locks in existing binding paths require UPDATE, but this role cannot log in
-- and is never granted to runtime accounts.
GRANT UPDATE ON gowm_device.device TO gowm_business_api_owner;
GRANT SELECT,INSERT,UPDATE ON gowm_device.device_service_binding TO gowm_business_api_owner;
GRANT SELECT,INSERT ON gowm_task.target_geometry,gowm_task.target_binding,
 gowm_execution.device_mission,gowm_execution.mission_identity,gowm_execution.execution_mission_link TO gowm_business_api_owner;

CREATE FUNCTION gowm_business_api.is_deployment_admin() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=SESSION_USER),false)
$$;

CREATE FUNCTION gowm_business_api.assert_device(p_scope text,p_device text,p_domain text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM gowm_device.device WHERE device_id=p_device AND data_scope_key=p_scope) THEN
  RAISE EXCEPTION 'BUSINESS_DEVICE_SCOPE_MISMATCH' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM gowm_device.device WHERE device_id=p_device AND enabled) THEN
  RAISE EXCEPTION 'DEVICE_DISABLED'; END IF;
 IF NOT gowm_business_api.is_deployment_admin() AND NOT EXISTS(
  SELECT 1 FROM gowm_business_api.service_authority a WHERE a.login_name=SESSION_USER AND a.data_scope_key=p_scope
  AND p_device=ANY(a.allowed_device_ids)
  AND (p_domain IS NULL OR a.business_domain=p_domain OR (a.business_domain='SMPP' AND p_domain='UGV_PROVIDER'))
 ) THEN RAISE EXCEPTION 'BUSINESS_CALLER_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION gowm_business_api.resolve_device(p_input jsonb,p_admit boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 scope_key text=p_input->>'scope'; chosen text=p_input->>'deviceId';
 svc text=p_input->>'smppServiceKey'; provider text=p_input->>'providerId'; resource text=p_input->>'resourceId';
 sdar text=p_input->>'sdarServiceKey'; server text=p_input->>'sdarMcpServerId'; profile text=p_input->>'agentProfileId';
 a gowm_business_api.service_authority; d gowm_device.device; b gowm_device.device_service_binding;
 actor jsonb; matches integer; boundary timestamptz; result_binding uuid; admin boolean;
BEGIN
 IF COALESCE(btrim(scope_key),'')='' OR COALESCE(btrim(svc),'')='' OR COALESCE(btrim(provider),'')=''
 OR COALESCE(btrim(resource),'')='' OR (sdar IS NULL)<>(server IS NULL)
 OR (p_input ? 'deviceId' AND COALESCE(btrim(chosen),'')='') OR (profile IS NOT NULL AND sdar IS NULL)
 THEN RAISE EXCEPTION 'BUSINESS_DEVICE_CONFIG_INVALID'; END IF;
 admin=gowm_business_api.is_deployment_admin();
 IF NOT admin THEN
  SELECT * INTO a FROM gowm_business_api.service_authority WHERE login_name=SESSION_USER AND data_scope_key=scope_key
   AND smpp_service_key=svc AND provider_id=provider AND resource_id=resource;
  IF NOT FOUND OR (sdar IS NOT NULL AND sdar IS DISTINCT FROM a.sdar_service_key)
   OR (server IS NOT NULL AND server IS DISTINCT FROM a.sdar_mcp_server_id)
   OR (profile IS NOT NULL AND profile IS DISTINCT FROM a.agent_profile_id)
  THEN RAISE EXCEPTION 'BUSINESS_CALLER_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 END IF;
 -- Retain the ordering used by the immutable 078 trigger and old admin code.
 IF p_admit THEN PERFORM pg_advisory_xact_lock(718078); END IF;
 SELECT * INTO b FROM gowm_device.device_service_binding WHERE data_scope_key=scope_key AND valid_to IS NULL
  AND smpp_service_key=svc AND provider_id=provider AND resource_id=resource;
 IF FOUND THEN
  IF chosen IS NOT NULL AND chosen<>b.device_id THEN RAISE EXCEPTION 'BUSINESS_BINDING_CONFLICT'; END IF;
  chosen=COALESCE(chosen,b.device_id);
 END IF;
 IF chosen IS NULL THEN
  IF NOT admin AND NOT a.allow_unique_default THEN RAISE EXCEPTION 'BUSINESS_DEFAULT_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
  SELECT count(*),min(device_id) INTO matches,chosen FROM gowm_device.device WHERE data_scope_key=scope_key AND enabled;
  IF matches=0 THEN RAISE EXCEPTION 'DEVICE_NO_MATCH'; END IF;
  IF matches<>1 THEN RAISE EXCEPTION 'DEVICE_AMBIGUOUS'; END IF;
 END IF;
 SELECT * INTO d FROM gowm_device.device WHERE device_id=chosen AND data_scope_key=scope_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'DEVICE_NO_MATCH'; END IF;
 IF NOT d.enabled THEN RAISE EXCEPTION 'DEVICE_DISABLED'; END IF;
 PERFORM gowm_business_api.assert_device(scope_key,chosen);
 PERFORM set_config('gowm.data_scope_key',scope_key,true);
 SELECT count(*),(jsonb_agg(v.reference_key_value)->0) INTO matches,actor
 FROM public.world_object o JOIN public.world_reference_identity i ON i.entity_kind='WORLD_OBJECT'
  AND i.internal_id=o.id AND i.data_scope_key=o.data_scope_key
 JOIN gowm_reference_v1.identity v ON v.reference_key=i.reference_key
 WHERE o.id=chosen AND o.data_scope_key=scope_key AND o.deleted_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.world_reference_retirement r WHERE r.reference_key=i.reference_key);
 IF matches<>1 OR actor->>'kind'<>'WORLD_OBJECT' THEN RAISE EXCEPTION 'DEVICE_WORLD_REFERENCE_UNAVAILABLE'; END IF;
 SELECT * INTO b FROM gowm_device.device_service_binding WHERE device_id=chosen AND valid_to IS NULL;
 IF FOUND THEN
  IF b.smpp_service_key<>svc OR b.provider_id<>provider OR b.resource_id<>resource
   OR (sdar IS NOT NULL AND b.sdar_service_key IS NOT NULL AND sdar<>b.sdar_service_key)
   OR (server IS NOT NULL AND b.sdar_mcp_server_id IS NOT NULL AND server<>b.sdar_mcp_server_id)
   OR (profile IS NOT NULL AND b.agent_profile_id IS NOT NULL AND profile<>b.agent_profile_id)
  THEN RAISE EXCEPTION 'BUSINESS_BINDING_CONFLICT'; END IF;
  result_binding=b.binding_id;
  IF (sdar IS NOT NULL AND b.sdar_service_key IS NULL) OR (server IS NOT NULL AND b.sdar_mcp_server_id IS NULL)
   OR (profile IS NOT NULL AND b.agent_profile_id IS NULL) THEN
   IF NOT p_admit THEN RAISE EXCEPTION 'BUSINESS_BINDING_INCOMPLETE'; END IF;
   UPDATE gowm_device.device_service_binding SET valid_to=GREATEST(clock_timestamp(),valid_from+interval '1 microsecond')
    WHERE binding_id=b.binding_id RETURNING valid_to INTO boundary;
   sdar=COALESCE(sdar,b.sdar_service_key); server=COALESCE(server,b.sdar_mcp_server_id); profile=COALESCE(profile,b.agent_profile_id);
   result_binding=NULL;
  END IF;
 END IF;
 IF result_binding IS NULL THEN
  IF NOT p_admit THEN RAISE EXCEPTION 'BUSINESS_BINDING_UNAVAILABLE'; END IF;
  INSERT INTO gowm_device.device_service_binding(data_scope_key,device_id,smpp_service_key,provider_id,resource_id,
   sdar_service_key,sdar_mcp_server_id,agent_profile_id,valid_from)
  VALUES(scope_key,chosen,svc,provider,resource,sdar,server,profile,COALESCE(boundary,clock_timestamp())) RETURNING binding_id INTO result_binding;
 END IF;
 RETURN jsonb_build_object('deviceId',chosen,'deviceIdentifier',d.device_identifier,'dataScopeKey',scope_key,
  'actorReferenceKey',actor,'bindingId',result_binding,'smppServiceKey',svc);
END $$;
ALTER FUNCTION gowm_business_api.is_deployment_admin() OWNER TO gowm_business_api_owner;
ALTER FUNCTION gowm_business_api.assert_device(text,text,text) OWNER TO gowm_business_api_owner;
ALTER FUNCTION gowm_business_api.resolve_device(jsonb,boolean) OWNER TO gowm_business_api_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_business_api FROM PUBLIC;
GRANT USAGE ON SCHEMA gowm_business_api TO gowm_business_client;
GRANT EXECUTE ON FUNCTION gowm_business_api.resolve_device(jsonb,boolean) TO gowm_business_client;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['ugv_smpp_app','ugv_sdar_app'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   IF shobj_description((SELECT oid FROM pg_roles WHERE rolname=r),'pg_authid') IS DISTINCT FROM
    'gowm-business-login-v1:'||replace(r,'_app','') THEN RAISE EXCEPTION 'BUSINESS_ACCOUNT_CONFLICT: %',r; END IF;
   EXECUTE format('GRANT gowm_business_client TO %I',r);
  END IF;
 END LOOP;
END $$;
-- Upgrade authority is derived only from already established bindings and managed
-- logins. No devices, service bindings, passwords or runtime data are initialized.
INSERT INTO gowm_business_api.service_authority(login_name,data_scope_key,business_domain,smpp_service_key,provider_id,resource_id,
 sdar_service_key,sdar_mcp_server_id,agent_profile_id,allowed_device_ids,allow_unique_default)
SELECT r.rolname,b.data_scope_key,CASE r.rolname WHEN 'ugv_smpp_app' THEN 'SMPP' ELSE 'SDAR' END,
 b.smpp_service_key,b.provider_id,b.resource_id,b.sdar_service_key,b.sdar_mcp_server_id,b.agent_profile_id,ARRAY[b.device_id],true
FROM gowm_device.device_service_binding b CROSS JOIN pg_roles r
WHERE b.valid_to IS NULL AND r.rolname IN ('ugv_smpp_app','ugv_sdar_app')
 AND shobj_description(r.oid,'pg_authid')='gowm-business-login-v1:'||replace(r.rolname,'_app','')
ON CONFLICT DO NOTHING;
COMMIT;
