BEGIN;

-- Migration 039 made this a read-only network consumer. Migrations 045/046
-- subsequently granted fenced runtime functions, but did not change the LOGIN
-- default. A real role login could not submit jobs (unlike SET ROLE tests).
-- No new table/schema/function privileges are granted here. Network reads
-- still open explicit READ ONLY transactions and runtime writes remain behind
-- the existing SECURITY DEFINER functions and their generation/scope guards.
ALTER ROLE route_planner_provider SET default_transaction_read_only=off;

COMMIT;
