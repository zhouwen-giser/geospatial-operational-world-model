BEGIN;

-- One projection head per native WORLD_OBJECT; immutable descriptor/name rows
-- grow with semantic metadata changes, never with incoming position samples.
CREATE TABLE public.world_object_catalog_projection (
  reference_key text PRIMARY KEY REFERENCES public.world_reference_identity(reference_key),
  data_scope_key text NOT NULL REFERENCES public.data_scope(scope_key),
  descriptor_version bigint NOT NULL,
  name_id uuid NOT NULL REFERENCES public.world_reference_name(name_id),
  metadata_hash text NOT NULL CHECK(metadata_hash ~ '^sha256:[0-9a-f]{64}$'),
  FOREIGN KEY(reference_key,descriptor_version)
    REFERENCES public.world_reference_descriptor_version(reference_key,descriptor_version)
);
REVOKE ALL ON public.world_object_catalog_projection FROM PUBLIC;

CREATE FUNCTION public.project_world_object_catalog(p_object_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE
  obj public.world_object%ROWTYPE;
  identity public.world_reference_identity%ROWTYPE;
  head public.world_object_catalog_projection%ROWTYPE;
  label text; kind text; metadata text; evidence jsonb; descriptor_id bigint; name_uuid uuid;
BEGIN
  SELECT * INTO obj FROM public.world_object WHERE id=p_object_id FOR UPDATE;
  IF NOT FOUND OR obj.deleted_at IS NOT NULL THEN RETURN false; END IF;
  SELECT * INTO identity FROM public.world_reference_identity
    WHERE entity_kind='WORLD_OBJECT' AND internal_id=obj.id;
  IF NOT FOUND OR identity.data_scope_key<>obj.data_scope_key THEN
    RAISE EXCEPTION 'world catalog identity ownership mismatch' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM public.world_reference_retirement WHERE reference_key=identity.reference_key)
    OR NOT EXISTS(SELECT 1 FROM public.world_object_state WHERE object_id=obj.id) THEN RETURN false; END IF;
  SELECT * INTO head FROM public.world_object_catalog_projection WHERE reference_key=identity.reference_key;
  -- Existing externally authored descriptors retain their authority and version semantics.
  IF head.reference_key IS NULL AND EXISTS(SELECT 1 FROM public.world_reference_descriptor_version
    WHERE reference_key=identity.reference_key) THEN RETURN false; END IF;
  label:=CASE WHEN jsonb_typeof(obj.properties->'name')='string' THEN NULLIF(btrim(obj.properties->>'name'),'') END;
  IF label IS NULL OR length(label)>512 THEN
    label:='Unnamed WORLD_OBJECT ['||identity.reference_key||']'; kind:='DISPLAY_LABEL';
  ELSE kind:='CANONICAL_NAME'; END IF;
  metadata:=public.grounding_sha256(jsonb_build_object('method','world-object-catalog/1',
    'reference',identity.reference_key,'scope',obj.data_scope_key,'type',obj.object_type,
    'subtype',obj.subtype,'label',label,'nameKind',kind)::text);
  IF head.metadata_hash=metadata THEN RETURN false; END IF;
  evidence:=jsonb_build_array(jsonb_build_object('evidenceId',identity.reference_key,
    'authority','GOWM Foundation','evidenceType','WORLD_OBJECT_CATALOG_METADATA'));
  INSERT INTO public.world_reference_descriptor_version(reference_key,data_scope_key,reference_type,
    display_name,provenance,content_hash)
  VALUES(identity.reference_key,obj.data_scope_key,obj.object_type,label,evidence,
    public.grounding_sha256(metadata||':'||COALESCE(head.descriptor_version::text,'initial')))
  RETURNING descriptor_version INTO descriptor_id;
  INSERT INTO public.world_reference_name(reference_key,data_scope_key,name_kind,name_text,
    normalized_text,source_ref,evidence,confidence)
  VALUES(identity.reference_key,obj.data_scope_key,kind,label,public.normalize_reference_text(label),
    'gowm:world-object-catalog/1',evidence,1) RETURNING name_id INTO name_uuid;
  INSERT INTO public.world_object_catalog_projection VALUES(identity.reference_key,obj.data_scope_key,
    descriptor_id,name_uuid,metadata)
  ON CONFLICT(reference_key) DO UPDATE SET descriptor_version=EXCLUDED.descriptor_version,
    name_id=EXCLUDED.name_id,metadata_hash=EXCLUDED.metadata_hash;
  -- Only the owned mutable search projection is replaced; immutable names stay untouched.
  IF head.name_id IS NOT NULL THEN DELETE FROM public.reference_search_projection
    WHERE data_scope_key=obj.data_scope_key AND reference_key=identity.reference_key
      AND source_id=head.name_id::text; END IF;
  INSERT INTO public.reference_search_projection(data_scope_key,reference_key,entity_kind,search_kind,
    normalized_text,match_priority,source_id,source_confidence)
  VALUES(obj.data_scope_key,identity.reference_key,'WORLD_OBJECT','REFERENCE_KEY',identity.reference_key,0,identity.reference_key,1),
    (obj.data_scope_key,identity.reference_key,'WORLD_OBJECT',kind,public.normalize_reference_text(label),
      CASE WHEN kind='CANONICAL_NAME' THEN 2 ELSE 4 END,name_uuid::text,1)
  ON CONFLICT DO NOTHING;
  RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.project_world_object_catalog(text) FROM PUBLIC;

CREATE FUNCTION public.project_world_object_catalog_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_TABLE_NAME='world_object' THEN PERFORM public.project_world_object_catalog(NEW.id);
  ELSE PERFORM public.project_world_object_catalog(NEW.object_id); END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.project_world_object_catalog_trigger() FROM PUBLIC;
CREATE TRIGGER zz_world_object_catalog_metadata AFTER INSERT OR UPDATE OF object_type,subtype,properties
  ON public.world_object FOR EACH ROW EXECUTE FUNCTION public.project_world_object_catalog_trigger();
CREATE TRIGGER world_object_catalog_initial_state AFTER INSERT ON public.world_object_state
  FOR EACH ROW EXECUTE FUNCTION public.project_world_object_catalog_trigger();

-- Existing columns retain their types/order; the additive current reference pin
-- is populated only for records owned by this projection. Legacy rows are unchanged.
CREATE OR REPLACE VIEW gowm_reference_v1.current_descriptor AS
SELECT DISTINCT ON (d.reference_key) d.reference_key,i.entity_kind,d.descriptor_version,d.reference_type,
  d.display_name,d.state_confidence,d.freshness_ms,d.stale,d.object_version,
  CASE WHEN p.reference_key IS NOT NULL THEN s.version ELSE d.world_version END AS world_version,
  d.geometry_summary,d.valid_from,d.valid_to,d.revalidation_required,d.provenance,d.content_hash,d.created_at,
  CASE WHEN p.reference_key IS NOT NULL THEN s.version::text ELSE d.descriptor_version::text END AS effective_reference_version
FROM public.world_reference_descriptor_version d JOIN public.world_reference_identity i USING(reference_key)
LEFT JOIN public.world_object_catalog_projection p ON p.reference_key=d.reference_key AND p.descriptor_version=d.descriptor_version
LEFT JOIN public.world_object_state s ON i.entity_kind='WORLD_OBJECT' AND s.object_id=i.internal_id
WHERE d.data_scope_key=gowm_reference_v1.current_data_scope_key()
ORDER BY d.reference_key,d.descriptor_version DESC;

CREATE OR REPLACE VIEW gowm_reference_v1.name_entry AS
SELECT n.name_id,n.reference_key,n.name_kind,n.language_tag,n.name_text,n.normalized_text,n.source_ref,
  n.evidence,n.confidence,n.valid_from,n.valid_to,n.created_at
FROM public.world_reference_name n LEFT JOIN public.world_object_catalog_projection p USING(reference_key)
WHERE n.data_scope_key=gowm_reference_v1.current_data_scope_key()
  AND (n.source_ref IS DISTINCT FROM 'gowm:world-object-catalog/1' OR n.name_id=p.name_id);

CREATE OR REPLACE VIEW gowm_reference_v1.identity AS
SELECT i.reference_key,i.entity_kind,jsonb_build_object('namespace','gowm','kind',i.entity_kind,
  'id',i.reference_key,'version',COALESCE(d.effective_reference_version,'1')) AS reference_key_value,i.created_at
FROM public.world_reference_identity i
LEFT JOIN gowm_reference_v1.current_descriptor d USING(reference_key)
WHERE i.data_scope_key=gowm_reference_v1.current_data_scope_key();

-- Rebuilds must not resurrect superseded native labels from immutable history.
CREATE OR REPLACE FUNCTION public.rebuild_reference_search_projection(p_data_scope_key text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE projected integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.data_scope WHERE scope_key=p_data_scope_key) THEN
    RAISE EXCEPTION 'unknown data scope' USING ERRCODE='42501';
  END IF;
  DELETE FROM public.reference_search_projection WHERE data_scope_key=p_data_scope_key;
  INSERT INTO public.reference_search_projection(data_scope_key,reference_key,entity_kind,search_kind,
    normalized_text,match_priority,source_id,source_confidence)
  SELECT i.data_scope_key,i.reference_key,i.entity_kind,'REFERENCE_KEY',i.reference_key,0,i.reference_key,1
    FROM public.world_reference_identity i WHERE i.data_scope_key=p_data_scope_key
  UNION ALL
  SELECT e.data_scope_key,e.reference_key,i.entity_kind,'EXTERNAL_ID',e.normalized_value,1,
    e.external_identifier_id::text,e.confidence
    FROM public.world_reference_external_identifier e JOIN public.world_reference_identity i USING(reference_key)
    WHERE e.data_scope_key=p_data_scope_key AND clock_timestamp()<@tstzrange(e.valid_from,e.valid_to,'[)')
  UNION ALL
  SELECT n.data_scope_key,n.reference_key,i.entity_kind,n.name_kind,n.normalized_text,
    CASE n.name_kind WHEN 'CODE' THEN 1 WHEN 'EXTERNAL_ID' THEN 1 WHEN 'CANONICAL_NAME' THEN 2
      WHEN 'ALIAS' THEN 3 ELSE 4 END,n.name_id::text,n.confidence
    FROM public.world_reference_name n JOIN public.world_reference_identity i USING(reference_key)
    LEFT JOIN public.world_object_catalog_projection p USING(reference_key)
    WHERE n.data_scope_key=p_data_scope_key AND clock_timestamp()<@tstzrange(n.valid_from,n.valid_to,'[)')
      AND (n.source_ref IS DISTINCT FROM 'gowm:world-object-catalog/1' OR n.name_id=p.name_id);
  GET DIAGNOSTICS projected=ROW_COUNT;
  RETURN projected;
END $fn$;

DO $roles$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gowm_reference_catalog_operator') THEN
    CREATE ROLE gowm_reference_catalog_operator NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $roles$;
GRANT USAGE ON SCHEMA public TO gowm_reference_catalog_operator;

CREATE FUNCTION public.plan_world_object_catalog_backfill(p_scope text,p_references text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE ref text; item record; items jsonb:='[]';
BEGIN
  IF p_scope IS NULL OR NOT EXISTS(SELECT 1 FROM public.data_scope WHERE scope_key=p_scope)
    OR cardinality(p_references) IS NULL OR cardinality(p_references) NOT BETWEEN 1 AND 1000
    OR (SELECT count(DISTINCT value) FROM unnest(p_references) value)<>cardinality(p_references) THEN
    RAISE EXCEPTION 'explicit unique scope/reference list required' USING ERRCODE='22023';
  END IF;
  FOREACH ref IN ARRAY p_references LOOP
    SELECT i.entity_kind,i.data_scope_key,i.internal_id,o.id,o.deleted_at,o.properties,o.object_type,o.subtype,
      EXISTS(SELECT 1 FROM public.world_reference_retirement r WHERE r.reference_key=i.reference_key) retired,
      EXISTS(SELECT 1 FROM public.world_object_state s WHERE s.object_id=o.id) has_state,
      EXISTS(SELECT 1 FROM public.world_object_catalog_projection h WHERE h.reference_key=i.reference_key) managed,
      EXISTS(SELECT 1 FROM public.world_reference_descriptor_version d WHERE d.reference_key=i.reference_key) described
    INTO item FROM public.world_reference_identity i LEFT JOIN public.world_object o
      ON o.id=i.internal_id AND o.data_scope_key=i.data_scope_key WHERE i.reference_key=ref;
    IF NOT FOUND OR item.entity_kind<>'WORLD_OBJECT' OR item.data_scope_key<>p_scope OR item.id IS NULL
      OR item.deleted_at IS NOT NULL OR item.retired OR NOT item.has_state THEN
      RAISE EXCEPTION 'backfill reference unavailable, retired or ownership invalid' USING ERRCODE='42501';
    END IF;
    items:=items||jsonb_build_array(jsonb_build_object('referenceKey',ref,'action',
      CASE WHEN item.managed THEN 'NOOP_CURRENT' WHEN item.described THEN 'NOOP_LEGACY' ELSE 'PROJECT' END,
      'inputHash',public.grounding_sha256(jsonb_build_object('id',item.id,'scope',p_scope,
        'type',item.object_type,'subtype',item.subtype,'name',item.properties->'name',
        'managed',item.managed,'described',item.described)::text)));
  END LOOP;
  RETURN jsonb_build_object('items',items,'planHash',public.grounding_sha256(items::text));
END $fn$;

CREATE FUNCTION public.apply_world_object_catalog_backfill(p_scope text,p_references text[],p_expected_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE ref text; object_id text; plan jsonb; applied integer:=0;
BEGIN
  IF current_setting('gowm.reference_catalog_allow_apply',true) IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'explicit backfill mutation authorization required' USING ERRCODE='42501';
  END IF;
  PERFORM public.plan_world_object_catalog_backfill(p_scope,p_references);
  FOR ref IN SELECT value FROM unnest(p_references) value ORDER BY value LOOP
    SELECT i.internal_id INTO object_id FROM public.world_reference_identity i WHERE i.reference_key=ref;
    PERFORM 1 FROM public.world_object WHERE id=object_id FOR UPDATE;
  END LOOP;
  plan:=public.plan_world_object_catalog_backfill(p_scope,p_references);
  IF p_expected_plan_hash IS DISTINCT FROM plan->>'planHash' THEN
    RAISE EXCEPTION 'backfill plan changed; repeat dry-run' USING ERRCODE='40001';
  END IF;
  FOREACH ref IN ARRAY p_references LOOP
    SELECT i.internal_id INTO object_id FROM public.world_reference_identity i WHERE i.reference_key=ref;
    IF public.project_world_object_catalog(object_id) THEN applied:=applied+1; END IF;
  END LOOP;
  RETURN jsonb_build_object('applied',applied,'beforePlanHash',plan->>'planHash');
END $fn$;
REVOKE ALL ON FUNCTION public.plan_world_object_catalog_backfill(text,text[]),
  public.apply_world_object_catalog_backfill(text,text[],text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plan_world_object_catalog_backfill(text,text[]),
  public.apply_world_object_catalog_backfill(text,text[],text) TO gowm_reference_catalog_operator;

COMMIT;
