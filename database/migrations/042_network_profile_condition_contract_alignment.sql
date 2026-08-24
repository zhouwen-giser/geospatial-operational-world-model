BEGIN;

ALTER TABLE network_cost_profile_version
  ADD COLUMN surface_weight_ppm integer NOT NULL DEFAULT 0
    CHECK (surface_weight_ppm BETWEEN 0 AND 1000000);
ALTER TABLE network_cost_profile_version
  DROP CONSTRAINT network_cost_profile_version_check;
ALTER TABLE network_cost_profile_version
  ADD CONSTRAINT network_cost_profile_version_weight_sum_check CHECK (
    distance_weight_ppm + duration_weight_ppm + risk_weight_ppm +
    energy_weight_ppm + surface_weight_ppm = 1000000
  );

ALTER TABLE network_arc_cost
  ADD COLUMN energy_mwh bigint NOT NULL DEFAULT 0 CHECK (energy_mwh >= 0);

ALTER TABLE network_arc_condition
  ADD COLUMN risk_override_microunits bigint
    CHECK (risk_override_microunits IS NULL OR risk_override_microunits >= 0),
  ADD COLUMN access_override_mask bigint
    CHECK (access_override_mask IS NULL OR access_override_mask >= 0),
  ADD COLUMN cost_multiplier_ppm integer
    CHECK (cost_multiplier_ppm IS NULL OR cost_multiplier_ppm BETWEEN 0 AND 10000000);

ALTER FUNCTION validate_network_cost_profile_version() SECURITY DEFINER;

CREATE OR REPLACE VIEW gowm_network_v1.cost_profile WITH (security_barrier = true) AS
SELECT profile.profile_key, version.cost_profile_version_id,
       version.travel_profile_version_id, version.version,
       version.distance_weight_ppm, version.duration_weight_ppm,
       version.risk_weight_ppm, version.energy_weight_ppm,
       version.formula, version.content_hash, version.surface_weight_ppm
FROM public.network_cost_profile profile
JOIN public.network_cost_profile_version version USING (cost_profile_id, travel_profile_id, data_scope_key)
WHERE profile.data_scope_key = gowm_network_v1.current_data_scope_key();

CREATE OR REPLACE VIEW gowm_network_v1.arc_cost WITH (security_barrier = true) AS
SELECT cost.graph_version_id, cost.arc_id, cost.travel_profile_version_id,
       cost.cost_profile_version_id, cost.distance_mm, cost.duration_ms,
       cost.risk_microunits, cost.energy_millijoules,
       cost.combined_cost_units, cost.content_hash, cost.energy_mwh
FROM public.network_arc_cost cost
JOIN public.network_graph_version version USING (graph_version_id, data_scope_key)
WHERE cost.data_scope_key = gowm_network_v1.current_data_scope_key()
  AND version.dataset_scope_key = gowm_network_v1.current_dataset_scope_key();

CREATE OR REPLACE VIEW gowm_network_v1.arc_condition WITH (security_barrier = true) AS
SELECT condition.condition_snapshot_id, condition.graph_version_id,
       condition.arc_id, condition.traversal_allowed,
       condition.speed_override_mm_per_s, condition.penalty_units,
       condition.reason_codes, condition.evidence, condition.content_hash,
       condition.risk_override_microunits, condition.access_override_mask,
       condition.cost_multiplier_ppm
FROM public.network_arc_condition condition
JOIN public.network_graph_version version USING (graph_version_id, data_scope_key)
WHERE condition.data_scope_key = gowm_network_v1.current_data_scope_key()
  AND version.dataset_scope_key = gowm_network_v1.current_dataset_scope_key();

COMMIT;
