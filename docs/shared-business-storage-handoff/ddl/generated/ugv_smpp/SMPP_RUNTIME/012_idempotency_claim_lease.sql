ALTER TABLE ugv_smpp.idempotency_record 
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN claim_attempt int
    NOT NULL
    DEFAULT 0
    CHECK (claim_attempt >= 0);

UPDATE ugv_smpp.idempotency_record SET lease_owner = 'migration-recovery:' || stable_task_id::text,lease_expires_at = clock_timestamp(),claim_attempt = 1 WHERE state = 'PENDING';

ALTER TABLE ugv_smpp.idempotency_record 
  DROP CONSTRAINT idempotency_record_payload_check RESTRICT;

ALTER TABLE ugv_smpp.idempotency_record 
  ADD CONSTRAINT idempotency_record_payload_check 
    CHECK (
    (state = 'PENDING'
      AND stable_task_id IS NOT NULL
      AND task_id IS NULL
      AND synchronous_result IS NULL
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL)
      OR (state = 'COMPLETE'
      AND (task_id IS NULL) <> (synchronous_result IS NULL)
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL)
  );

DROP INDEX idempotency_record_pending_idx;

CREATE INDEX idempotency_record_pending_lease_idx ON ugv_smpp.idempotency_record (lease_expires_at, updated_at) WHERE state = 'PENDING';
