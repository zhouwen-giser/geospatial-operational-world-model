-- CONSERVATIVE STBOX COARSE, CAP+1 BUDGET CHECK ONLY.
-- $1 scope,$2 subject version,$3 span,$4 conservative radius,$5 cap.
-- The repository must reject/queue when cap+1 rows return, freeze every id when
-- <=cap, and only then run 12b. Never claim this bounded list is a result page.
WITH s AS (
 SELECT tr.tracklet_id,tr.analysis_space_id,atTime(tv.trajectory,$3::tstzspan) t
 FROM gowm_stas_v1.tracklet_version tv JOIN gowm_stas_v1.tracklet tr USING(tracklet_id)
 WHERE tr.data_scope_id=$1::uuid AND tv.tracklet_version_id=$2::uuid
), c AS (
 SELECT tv.tracklet_version_id,tv.tracklet_id,tv.version_no
 FROM s JOIN gowm_stas_v1.tracklet tr ON tr.data_scope_id=$1::uuid
   AND tr.analysis_space_id=s.analysis_space_id AND tr.tracklet_id<>s.tracklet_id
 JOIN gowm_stas_v1.tracklet_head h ON h.tracklet_id=tr.tracklet_id
 JOIN gowm_stas_v1.tracklet_version tv ON tv.tracklet_version_id=h.current_version_id
 WHERE s.t IS NOT NULL AND tv.trajectory && $3::tstzspan
   AND tv.trajectory && expandSpace(s.t,$4::double precision)
 ORDER BY tv.tracklet_version_id LIMIT ($5::integer+1)
)
SELECT * FROM c ORDER BY tracklet_version_id;
