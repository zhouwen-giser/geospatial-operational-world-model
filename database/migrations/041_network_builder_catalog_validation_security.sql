BEGIN;

-- These trigger-only validators must inspect authoritative Catalog base rows
-- without granting the network builder direct base-table read authority.
ALTER FUNCTION validate_network_graph_version_source() SECURITY DEFINER;
ALTER FUNCTION validate_network_feature_binding() SECURITY DEFINER;

COMMIT;
