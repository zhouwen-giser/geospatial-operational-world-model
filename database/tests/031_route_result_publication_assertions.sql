\set ON_ERROR_STOP on
BEGIN;
INSERT INTO data_scope(scope_key,operational_domain,description) VALUES('route-result-test','TEST','Route result publication test');
DO $assert$
DECLARE request_id uuid; generation integer; published boolean; replay jsonb; candidate_id uuid;
BEGIN
  SELECT route_request_id INTO request_id FROM route_planner_runtime.submit_route_request('route-result-test','dataset-a','request-a','idem-a','sha256:'||repeat('1',64),'{}','wrf_'||repeat('1',32));
  SELECT claimed.generation INTO generation FROM route_planner_runtime.claim_route_request(request_id,'worker-a',30) claimed;
  published:=route_planner_runtime.publish_route_result(request_id,generation,'worker-a',jsonb_build_object('requestId','request-a','status','COMPLETED','queryResultReferenceKey',jsonb_build_object('namespace','gowm','kind','QUERY_RESULT','id','wrf_'||repeat('1',32),'version','1'),'routingSnapshot',jsonb_build_object('graphVersion','1'),'candidates',jsonb_build_array(jsonb_build_object('rank',1,'routeSignature','sha256:'||repeat('2',64),'segments',jsonb_build_array(jsonb_build_object('graphVersion','1','arcKey','arc_'||repeat('3',64),'startFractionPpm',0,'endFractionPpm',1000000,'segmentRole','ROUTE','distanceMm',1,'durationMs',2,'riskMicroUnits',3,'energyMwh',4,'turnPenaltyUnits',0)),'metrics',jsonb_build_object('distanceMm',1,'durationMs',2,'riskMicroUnits',3,'energyMwh',4,'combinedCostUnits',5),'verification',jsonb_build_object('status','VALID','verifierVersion','v1','verifiedResultHash','sha256:'||repeat('4',64),'checks',jsonb_build_array()))),'validUntil',to_char(clock_timestamp()+interval '1 hour','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revalidationRequired',true),'sha256:'||repeat('5',64),'sha256:'||repeat('6',64),'solver/1','verifier/1');
  IF NOT published THEN RAISE EXCEPTION 'route result publication failed'; END IF;
  SELECT route_planner_runtime.get_route_result(request_id,'route-result-test','dataset-a') INTO replay;
  IF replay IS NULL OR replay->>'requestId'<>'request-a' THEN RAISE EXCEPTION 'exact route replay unavailable'; END IF;
  SELECT route_candidate_id INTO STRICT candidate_id FROM route_planner_runtime.route_candidate WHERE route_request_id=request_id;
  BEGIN UPDATE route_planner_runtime.route_candidate SET rank=2 WHERE route_candidate_id=candidate_id; RAISE EXCEPTION 'candidate mutation accepted'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  IF route_planner_runtime.publish_route_result(request_id,generation,'worker-a',replay,'sha256:'||repeat('5',64),'sha256:'||repeat('6',64),'solver/1','verifier/1') THEN RAISE EXCEPTION 'terminal overwrite accepted'; END IF;
  PERFORM gowm_result_v1.set_data_scope('route-result-test');
  IF (SELECT count(*) FROM gowm_result_v1.route_query_result)<>1 THEN RAISE EXCEPTION 'route QueryResult registry publication missing'; END IF;
END
$assert$;
ROLLBACK;
SELECT 'ROUTE_RESULT_PUBLICATION_ASSERTIONS_PASS' AS result;
