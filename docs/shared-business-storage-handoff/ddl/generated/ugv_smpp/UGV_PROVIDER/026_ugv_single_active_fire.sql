CREATE UNIQUE INDEX IF NOT EXISTS ugv_single_active_fire_execution ON ugv_smpp.ugv_execution (resource_id) WHERE operation_name = 'vehicle_fire_weapon'
  AND state NOT IN ('SUCCEEDED', 'BUSINESS_FAILED', 'CANCELLED', 'TECHNICAL_FAILED');
