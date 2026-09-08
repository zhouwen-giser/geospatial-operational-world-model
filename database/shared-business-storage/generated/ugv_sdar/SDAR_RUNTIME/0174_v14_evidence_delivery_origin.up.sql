CREATE TABLE ugv_sdar.evidence_export_delivery_origin (
  export_id text PRIMARY KEY,
  first_revision bigint NOT NULL,
  delivery_start text NOT NULL CHECK (delivery_start IN ('retained', 'from_activation')),
  start_sequence bigint NOT NULL CHECK (start_sequence >= 0),
  activated_at timestamptz NOT NULL,
  FOREIGN KEY(export_id, first_revision)
    REFERENCES ugv_sdar.evidence_export_configuration (export_id, revision),
  CHECK (
    delivery_start <> 'retained'
      OR start_sequence = 0
  )
);

INSERT INTO ugv_sdar.evidence_export_delivery_origin SELECT DISTINCT ON (export_id)
  export_id,
  revision,
  'retained',
  0,
  applied_at
FROM ugv_sdar.evidence_export_configuration
ORDER BY
  export_id,
  revision;

CREATE FUNCTION ugv_sdar.evidence_delivery_start_sequence(
  destination text
) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT start_sequence FROM evidence_export_delivery_origin
                  WHERE export_id=destination),0);
$$ SET search_path TO ugv_sdar, public, pg_catalog;

CREATE FUNCTION ugv_sdar.evidence_delivery_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'EVIDENCE_DELIVERY_ORIGIN_IMMUTABLE';
END;
$$ SET search_path TO ugv_sdar, public, pg_catalog;

CREATE TRIGGER evidence_delivery_origin_immutable
  BEFORE DELETE OR UPDATE
  ON ugv_sdar.evidence_export_delivery_origin
  FOR EACH ROW
  EXECUTE PROCEDURE evidence_delivery_origin_immutable();

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0174_v14_evidence_delivery_origin');
