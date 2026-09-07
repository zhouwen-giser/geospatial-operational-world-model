BEGIN;
-- No old revision is rewritten. The new profile is a different semantic
-- request identity, so cached v1 results cannot satisfy evidence-count reads.
WITH profile AS (SELECT '{"sourceSelection":"SINGLE_AUTHORITATIVE_SOURCE","crossGapInterpolation":false,"multipleCandidates":"INDETERMINATE","sampleSemantics":"ORIGINAL_MEASUREMENT_V1","geometryNodeCountIsNotSampleCount":true}'::jsonb definition)
INSERT INTO gowm_history.method_profile(profile_key,profile_version,profile_kind,definition,content_hash)
SELECT 'trajectory-single-authoritative-v2','2.0','TRAJECTORY_SELECTION',definition,public.grounding_sha256(definition::text) FROM profile;
ALTER TABLE gowm_history.historical_trajectory_segment
 DROP CONSTRAINT historical_trajectory_segment_sample_count_check,
 ADD CONSTRAINT historical_trajectory_segment_sample_count_check CHECK(sample_count>=0);
COMMENT ON COLUMN gowm_history.historical_trajectory_segment.sample_count IS
 'v1 profile: legacy geometry node count. v2 profile: original input count, possibly zero for an interpolated slice. Use gowm_history_v2 for explicit count semantics.';
COMMIT;
