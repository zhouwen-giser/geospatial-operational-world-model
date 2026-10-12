BEGIN;
-- Pause projection workers during this upgrade. Locks make the evidence-to-
-- projection cut atomic; canonical facts and legacy aggregate tables are retained.
LOCK TABLE public.world_observation,public.world_object,public.world_object_geometry,
 public.world_object_state IN SHARE MODE;
CREATE SCHEMA gowm_situation;
CREATE TABLE gowm_situation.cell (LIKE public.situation_cell INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 data_scope_key text NOT NULL REFERENCES public.data_scope(scope_key),
 PRIMARY KEY(data_scope_key,h3_index,resolution));
CREATE TABLE gowm_situation.observer (
 data_scope_key text NOT NULL,h3_index public.h3index NOT NULL,resolution smallint NOT NULL,
 observer_id text NOT NULL,first_observed_at timestamptz NOT NULL,last_observed_at timestamptz NOT NULL,
 observation_count bigint NOT NULL DEFAULT 1 CHECK(observation_count>0),
 PRIMARY KEY(data_scope_key,h3_index,resolution,observer_id),
 FOREIGN KEY(data_scope_key,h3_index,resolution) REFERENCES gowm_situation.cell(data_scope_key,h3_index,resolution)
);
WITH evidence AS MATERIALIZED (
 SELECT o.data_scope_key,o.observer_id,o.observed_at,r.resolution,
  public.h3_latlng_to_cell(o.geometry,r.resolution) h3_index
 FROM public.world_observation o CROSS JOIN (VALUES(7),(8),(9),(10)) r(resolution)
 WHERE o.projected_at IS NOT NULL AND o.status IN ('projected','superseded')
  AND o.entity_binding_status<>'CANDIDATE' AND public.GeometryType(o.geometry)='POINT'
), cells AS (
 INSERT INTO gowm_situation.cell(data_scope_key,h3_index,resolution,observation_count,unique_observer_count,last_observed_at,world_version)
 SELECT data_scope_key,h3_index,resolution,count(*),count(DISTINCT observer_id),max(observed_at),
  (SELECT last_value FROM public.world_version_seq) FROM evidence GROUP BY data_scope_key,h3_index,resolution
 RETURNING data_scope_key,h3_index,resolution
)
INSERT INTO gowm_situation.observer(data_scope_key,h3_index,resolution,observer_id,first_observed_at,last_observed_at,observation_count)
 SELECT e.data_scope_key,e.h3_index,e.resolution,e.observer_id,min(e.observed_at),max(e.observed_at),count(*)
 FROM evidence e JOIN cells c USING(data_scope_key,h3_index,resolution)
 GROUP BY e.data_scope_key,e.h3_index,e.resolution,e.observer_id;

INSERT INTO gowm_situation.cell(data_scope_key,h3_index,resolution,agent_count,vehicle_count,sensor_count,incident_count,world_version)
 SELECT o.data_scope_key,h.cell,h.resolution,
 count(*) FILTER(WHERE o.object_type='Agent'),
 count(*) FILTER(WHERE o.object_type IN('Vehicle','UGV','UAV')),
 count(*) FILTER(WHERE o.object_type IN('Device','Sensor','Camera')),
 count(*) FILTER(WHERE o.object_type IN('Incident','Alert')),max(s.version)
 FROM public.world_object o JOIN public.world_object_geometry g ON g.object_id=o.id
 JOIN public.world_object_state s ON s.object_id=o.id
 CROSS JOIN LATERAL(VALUES(7,g.h3_r7),(8,g.h3_r8),(9,g.h3_r9),(10,g.h3_r10)) h(resolution,cell)
 WHERE o.deleted_at IS NULL AND h.cell IS NOT NULL
 GROUP BY o.data_scope_key,h.cell,h.resolution
 ON CONFLICT(data_scope_key,h3_index,resolution) DO UPDATE SET
 agent_count=EXCLUDED.agent_count,vehicle_count=EXCLUDED.vehicle_count,sensor_count=EXCLUDED.sensor_count,
 incident_count=EXCLUDED.incident_count,world_version=GREATEST(gowm_situation.cell.world_version,EXCLUDED.world_version);

-- Current object counters follow all geometry/type/delete mutations, including
-- manual commands. Historical observation/observer counters never decrement.
CREATE FUNCTION gowm_situation.object_cell_delta(p_scope text,p_type text,p_cell public.h3index,p_resolution integer,p_delta integer,p_version bigint)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a integer:=0;v integer:=0;s integer:=0;i integer:=0;
BEGIN
 IF p_cell IS NULL THEN RETURN; END IF;
 IF p_type='Agent' THEN a:=p_delta;
 ELSIF p_type IN('Vehicle','UGV','UAV') THEN v:=p_delta;
 ELSIF p_type IN('Device','Sensor','Camera') THEN s:=p_delta;
 ELSIF p_type IN('Incident','Alert') THEN i:=p_delta;
 ELSE RETURN; END IF;
 INSERT INTO gowm_situation.cell(data_scope_key,h3_index,resolution,agent_count,vehicle_count,sensor_count,incident_count,world_version)
 VALUES(p_scope,p_cell,p_resolution,GREATEST(0,a),GREATEST(0,v),GREATEST(0,s),GREATEST(0,i),p_version)
 ON CONFLICT(data_scope_key,h3_index,resolution) DO UPDATE SET
 agent_count=GREATEST(0,gowm_situation.cell.agent_count+a),vehicle_count=GREATEST(0,gowm_situation.cell.vehicle_count+v),
 sensor_count=GREATEST(0,gowm_situation.cell.sensor_count+s),incident_count=GREATEST(0,gowm_situation.cell.incident_count+i),
 world_version=GREATEST(gowm_situation.cell.world_version,p_version),updated_at=clock_timestamp();
END $$;
CREATE FUNCTION gowm_situation.object_projection_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous public.world_object_geometry%ROWTYPE;next public.world_object_geometry%ROWTYPE;
 old_scope text;new_scope text;old_type text;new_type text;identity text;version bigint;h record;
BEGIN
 IF TG_TABLE_NAME='world_object_geometry' THEN
  identity:=CASE WHEN TG_OP='DELETE' THEN OLD.object_id ELSE NEW.object_id END;
  SELECT data_scope_key,object_type INTO new_scope,new_type FROM public.world_object WHERE id=identity AND deleted_at IS NULL;
  old_scope:=new_scope;old_type:=new_type;
  IF TG_OP<>'INSERT' THEN previous:=OLD; END IF;
  IF TG_OP<>'DELETE' THEN next:=NEW; END IF;
 ELSIF TG_OP='DELETE' THEN
  identity:=OLD.id;old_scope:=OLD.data_scope_key;old_type:=OLD.object_type;
  SELECT * INTO previous FROM public.world_object_geometry WHERE object_id=identity;
  IF OLD.deleted_at IS NOT NULL THEN old_scope:=NULL; END IF;
 ELSE
  identity:=NEW.id;
  IF OLD.data_scope_key IS NOT DISTINCT FROM NEW.data_scope_key AND OLD.object_type=NEW.object_type
    AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN RETURN NULL; END IF;
  SELECT * INTO next FROM public.world_object_geometry WHERE object_id=identity;previous:=next;
  IF OLD.deleted_at IS NULL THEN old_scope:=OLD.data_scope_key;old_type:=OLD.object_type; END IF;
  IF NEW.deleted_at IS NULL THEN new_scope:=NEW.data_scope_key;new_type:=NEW.object_type; END IF;
 END IF;
 SELECT COALESCE(max(s.version),0) INTO version FROM public.world_object_state s WHERE object_id=identity;
 FOR h IN SELECT * FROM (VALUES(7,previous.h3_r7,next.h3_r7),(8,previous.h3_r8,next.h3_r8),
  (9,previous.h3_r9,next.h3_r9),(10,previous.h3_r10,next.h3_r10)) x(resolution,old_cell,new_cell) ORDER BY resolution LOOP
  IF old_scope IS NOT DISTINCT FROM new_scope AND old_type IS NOT DISTINCT FROM new_type AND h.old_cell::text IS NOT DISTINCT FROM h.new_cell::text THEN CONTINUE; END IF;
  IF old_scope IS NOT NULL THEN PERFORM gowm_situation.object_cell_delta(old_scope,old_type,h.old_cell,h.resolution,-1,version); END IF;
  IF new_scope IS NOT NULL THEN PERFORM gowm_situation.object_cell_delta(new_scope,new_type,h.new_cell,h.resolution,1,version); END IF;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION gowm_situation.object_cell_delta(text,text,public.h3index,integer,integer,bigint),gowm_situation.object_projection_changed() FROM PUBLIC;
CREATE TRIGGER scoped_situation_geometry AFTER INSERT OR UPDATE OR DELETE ON public.world_object_geometry
 FOR EACH ROW EXECUTE FUNCTION gowm_situation.object_projection_changed();
CREATE TRIGGER scoped_situation_identity AFTER UPDATE OF data_scope_key,object_type,deleted_at ON public.world_object
 FOR EACH ROW EXECUTE FUNCTION gowm_situation.object_projection_changed();
CREATE TRIGGER scoped_situation_delete BEFORE DELETE ON public.world_object
 FOR EACH ROW EXECUTE FUNCTION gowm_situation.object_projection_changed();

CREATE INDEX scoped_situation_observations_idx ON gowm_situation.cell(data_scope_key,resolution,observation_count DESC);
CREATE INDEX scoped_situation_freshness_idx ON gowm_situation.cell(data_scope_key,resolution,last_observed_at DESC);
CREATE INDEX scoped_situation_observers_idx ON gowm_situation.cell(data_scope_key,resolution,unique_observer_count);
CREATE VIEW gowm_situation.cell_scored WITH(security_barrier=true) AS
 SELECT data_scope_key,h3_index,resolution,agent_count,vehicle_count,sensor_count,incident_count,observation_count,
 LEAST(100,GREATEST(0,incident_count*20+observation_count*0.02))::double precision derived_risk_score,
 LEAST(100,GREATEST(0,unique_observer_count*20))::double precision derived_coverage_score,
 LEAST(100,GREATEST(0,LN(1+observation_count)*12))::double precision derived_activity_score,
 CASE WHEN last_observed_at IS NULL THEN 0 ELSE GREATEST(0,100-EXTRACT(EPOCH FROM(clock_timestamp()-last_observed_at))/3) END::double precision derived_freshness_score,
 last_observed_at,world_version,updated_at FROM gowm_situation.cell
 WHERE data_scope_key=NULLIF(current_setting('gowm.data_scope_key',true),'');
REVOKE ALL ON ALL TABLES IN SCHEMA gowm_situation FROM PUBLIC;
GRANT USAGE ON SCHEMA gowm_situation TO gowm_situation_reader;
GRANT SELECT ON gowm_situation.cell_scored TO gowm_situation_reader;
REVOKE SELECT ON public.situation_cell_scored FROM gowm_situation_reader;
COMMENT ON SCHEMA gowm_situation IS 'Rebuildable current H3 projection from scoped canonical evidence. Legacy global aggregates remain unmodified and are not read by v2.';
COMMIT;
