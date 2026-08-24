BEGIN;

-- CapabilityDescriptor v1 permits an optional RFC 6901 JSON Pointer `path`
-- on a typed port.  Keep the database Registry constraint aligned with that
-- canonical contract so hash-locked manifests can be persisted losslessly.
CREATE OR REPLACE FUNCTION gowm_capability.valid_capability_ports(p_ports jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $fn$
DECLARE
  port jsonb;
  port_count integer;
  distinct_port_count integer;
BEGIN
  IF jsonb_typeof(p_ports) <> 'object' OR
     jsonb_typeof(p_ports->'inputs') <> 'array' OR
     jsonb_typeof(p_ports->'outputs') <> 'array' OR
     jsonb_array_length(p_ports->'inputs') > 64 OR
     jsonb_array_length(p_ports->'outputs') NOT BETWEEN 1 AND 64 THEN
    RETURN false;
  END IF;

  FOR port IN
    SELECT value
    FROM jsonb_array_elements((p_ports->'inputs') || (p_ports->'outputs'))
  LOOP
    IF jsonb_typeof(port) <> 'object' OR
       NOT port ?& ARRAY['name','schemaUri','schemaHash','valueKind','unitSemantics'] OR
       port - ARRAY['name','path','schemaUri','schemaHash','valueKind','unitSemantics'] <> '{}'::jsonb OR
       port->>'name' !~ '^[a-z][A-Za-z0-9_]{0,63}$' OR
       (port ? 'path' AND COALESCE(
         jsonb_typeof(port->'path') = 'string' AND
         length(port->>'path') BETWEEN 2 AND 512 AND
         port->>'path' ~ '^/(?:[^~/]|~[01])+(?:/(?:[^~/]|~[01])+)*$',
         false
       ) = false) OR
       length(port->>'schemaUri') NOT BETWEEN 1 AND 512 OR
       port->>'schemaHash' !~ '^sha256:[0-9a-f]{64}$' OR
       port->>'valueKind' NOT IN (
         'ANY','SCALAR','POSITION','POSITIONS','GEOMETRY','FEATURE','FEATURE_COLLECTION',
         'H3_CELL','H3_CELL_SET','REFERENCE_KEY','DATASET_VERSION','ROW_SET','ARTIFACT_REFERENCE'
       ) OR
       port->>'unitSemantics' NOT IN (
         'UNSPECIFIED','DIMENSIONLESS','ANGULAR_DEGREES','LINEAR_METERS','DISCRETE'
       ) THEN
      RETURN false;
    END IF;
  END LOOP;

  SELECT count(*), count(DISTINCT value->>'name')
  INTO port_count, distinct_port_count
  FROM jsonb_array_elements(p_ports->'inputs');
  IF port_count <> distinct_port_count THEN RETURN false; END IF;

  SELECT count(*), count(DISTINCT value->>'name')
  INTO port_count, distinct_port_count
  FROM jsonb_array_elements(p_ports->'outputs');
  IF port_count <> distinct_port_count THEN RETURN false; END IF;

  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION gowm_capability.valid_capability_ports(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_capability.valid_capability_ports(jsonb)
  TO gowm_gateway_runtime, gowm_gateway_registry_admin;

COMMIT;
