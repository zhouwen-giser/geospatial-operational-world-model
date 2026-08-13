\set ON_ERROR_STOP on

DO $assert_versions$
DECLARE mobility_version text;
  contract text;
BEGIN
  SELECT extversion INTO STRICT mobility_version FROM pg_extension WHERE extname='mobilitydb';
  SELECT contract_version INTO STRICT contract FROM gowm_deployment_config WHERE singleton;
  IF mobility_version !~ '^1\.3(\.|$)' OR contract<>'1.2.0' THEN
    RAISE EXCEPTION 'unexpected runtime contract: MobilityDB %, GOWM+ %',mobility_version,contract;
  END IF;
  IF (SELECT extversion FROM pg_extension WHERE extname='h3') !~ '^4\.5(\.|$)' THEN
    RAISE EXCEPTION 'GOWM+ v1.2 reference image requires h3-pg 4.5.x';
  END IF;
END
$assert_versions$;

DO $assert_catalog$
DECLARE archive_kind "char";
  compatibility_kind "char";
  temporal_type text;
BEGIN
  SELECT relkind INTO STRICT archive_kind FROM pg_class WHERE relname='trajectory_point_v11_archive';
  SELECT relkind INTO STRICT compatibility_kind FROM pg_class WHERE relname='trajectory_point';
  IF archive_kind<>'r' OR compatibility_kind<>'v' THEN
    RAISE EXCEPTION 'trajectory_point must be a compatibility view over the v1.1 archive';
  END IF;
  SELECT format_type(a.atttypid,a.atttypmod) INTO STRICT temporal_type
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
  WHERE c.relname='mobility_tracklet_version' AND a.attname='trajectory';
  IF temporal_type NOT LIKE 'tgeompoint(SequenceSet,Point%' THEN
    RAISE EXCEPTION 'unexpected MobilityDB trajectory typmod: %',temporal_type;
  END IF;
  IF to_regprocedure('asMFJSON(tgeompoint,integer,integer,integer)') IS NULL OR
     to_regprocedure('tDwithin(tgeompoint,tgeompoint,double precision,boolean)') IS NULL THEN
    RAISE EXCEPTION 'required MobilityDB v1.3 stable API is missing';
  END IF;
  IF to_regprocedure('tDwithin(tgeogpoint,tgeogpoint,double precision)') IS NOT NULL OR
     to_regprocedure('eDwithinPairs(tgeompoint[],double precision)') IS NOT NULL THEN
    RAISE EXCEPTION 'unreviewed/master-only MobilityDB API detected';
  END IF;
END
$assert_catalog$;

DO $assert_unknown_gap$
DECLARE trajectory_value tgeompoint;
  midpoint geometry;
BEGIN
  trajectory_value := tgeompointSeqSet(ARRAY[
    tgeompointSeq(ARRAY[
      tgeompoint(ST_SetSRID(ST_MakePoint(448000,4417000),32650),'2026-08-13T00:00:00Z'::timestamptz),
      tgeompoint(ST_SetSRID(ST_MakePoint(448001,4417000),32650),'2026-08-13T00:00:01Z'::timestamptz)
    ],'linear'),
    tgeompointSeq(ARRAY[
      tgeompoint(ST_SetSRID(ST_MakePoint(448010,4417000),32650),'2026-08-13T00:00:05Z'::timestamptz),
      tgeompoint(ST_SetSRID(ST_MakePoint(448011,4417000),32650),'2026-08-13T00:00:06Z'::timestamptz)
    ],'linear')
  ]);
  midpoint := valueAtTimestamp(trajectory_value,'2026-08-13T00:00:03Z'::timestamptz);
  IF numSequences(trajectory_value)<>2 OR midpoint IS NOT NULL THEN
    RAISE EXCEPTION 'SequenceSet UNKNOWN GAP semantics failed';
  END IF;
  IF valueAtTimestamp(trajectory_value,'2026-08-13T00:00:01Z'::timestamptz) IS NULL OR
     valueAtTimestamp(trajectory_value,'2026-08-13T00:00:05Z'::timestamptz) IS NULL THEN
    RAISE EXCEPTION 'gap endpoints must remain defined';
  END IF;
END
$assert_unknown_gap$;

DO $assert_guards$
DECLARE immutable_triggers integer;
BEGIN
  SELECT count(*) INTO immutable_triggers FROM pg_trigger
  WHERE NOT tgisinternal AND tgname LIKE '%_immutable';
  IF immutable_triggers<12 THEN
    RAISE EXCEPTION 'append-only guard set incomplete: %',immutable_triggers;
  END IF;
  IF to_regprocedure('gowm_tracklet_candidates(text,text,text,text,text,text)') IS NULL OR
     to_regprocedure('gowm_rebuild_mobility_tracklet(text,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'source-local tracker-session-aware builder API missing';
  END IF;
END
$assert_guards$;

SELECT 'GOWM+ v1.2 database assertions PASS' AS result;
