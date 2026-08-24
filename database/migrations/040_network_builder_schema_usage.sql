BEGIN;

-- Table grants in migration 038 remain unusable without schema visibility.
-- This does not broaden the builder's table-level SELECT/INSERT-only authority.
GRANT USAGE ON SCHEMA public TO network_builder;

COMMIT;
