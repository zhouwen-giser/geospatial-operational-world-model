BEGIN;

-- Additive provider read closure. Do not grant access to Foundation base tables.
CREATE VIEW gowm_operational_reality_v1.scope_identity WITH (security_barrier=true) AS
SELECT identity.reference_key
FROM public.world_reference_identity identity
WHERE identity.entity_kind='DATA_SCOPE'
  AND identity.data_scope_key=gowm_operational_reality_v1.current_data_scope_key();

CREATE VIEW gowm_operational_reality_v1.world_source WITH (security_barrier=true) AS
SELECT identity.reference_key,state.source
FROM public.world_reference_identity identity
JOIN public.world_object_state state ON state.object_id=identity.internal_id
WHERE identity.entity_kind='WORLD_OBJECT'
  AND identity.data_scope_key=gowm_operational_reality_v1.current_data_scope_key()
  AND state.source IS NOT NULL;

REVOKE ALL ON gowm_operational_reality_v1.scope_identity,
  gowm_operational_reality_v1.world_source FROM PUBLIC;
GRANT SELECT ON gowm_operational_reality_v1.scope_identity,
  gowm_operational_reality_v1.world_source TO gowm_operational_reader;

COMMIT;
