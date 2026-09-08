CREATE TABLE ugv_sdar.development_isolated_demo_audit (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('requested', 'confirmed')),
  payload jsonb NOT NULL,
  UNIQUE (request_id, phase)
);

CREATE FUNCTION ugv_sdar.development_isolated_demo_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SOFTWARE_DEMO_AUDIT_APPEND_ONLY';
END;
$$ SET search_path TO ugv_sdar, public, pg_catalog;

CREATE TRIGGER development_isolated_demo_immutable
  BEFORE DELETE OR UPDATE
  ON ugv_sdar.development_isolated_demo_audit
  FOR EACH ROW
  EXECUTE PROCEDURE development_isolated_demo_append_only();

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0178_v14_development_isolated_demo');
