BEGIN;
DO $assert$
DECLARE request_id uuid; replay_id uuid; generation_one integer; generation_two integer; completed boolean;
BEGIN
  SELECT route_request_id INTO request_id FROM route_planner_runtime.submit_route_request('route-runtime-a','dataset-a','request-a','idem-a','sha256:'||repeat('1',64),'{}','wrf_'||repeat('1',32));
  SELECT route_request_id INTO replay_id FROM route_planner_runtime.submit_route_request('route-runtime-a','dataset-a','request-a','idem-a','sha256:'||repeat('1',64),'{}','wrf_'||repeat('1',32));
  IF request_id<>replay_id THEN RAISE EXCEPTION 'idempotent submit changed request identity'; END IF;
  SELECT generation INTO generation_one FROM route_planner_runtime.claim_route_request(request_id,'worker-a',1);
  UPDATE route_planner_runtime.route_run SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE route_request_id=request_id AND generation=generation_one;
  SELECT generation INTO generation_two FROM route_planner_runtime.claim_route_request(request_id,'worker-b',30);
  IF generation_two<>generation_one+1 THEN RAISE EXCEPTION 'expired lease generation was not reclaimed'; END IF;
  IF NOT route_planner_runtime.cancel_route_request(request_id,'race') THEN RAISE EXCEPTION 'cancel failed'; END IF;
  completed := route_planner_runtime.complete_route_request(request_id,generation_two,'worker-b','COMPLETED','sha256:'||repeat('2',64));
  IF completed OR (SELECT status FROM route_planner_runtime.route_request WHERE route_request_id=request_id)<>'CANCELLED' THEN RAISE EXCEPTION 'late completion overwrote cancellation'; END IF;
  IF has_table_privilege('route_planner_provider','route_planner_runtime.route_request','INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'route planner has direct runtime mutation privileges'; END IF;
  IF NOT has_function_privilege('route_planner_provider','route_planner_runtime.submit_route_request(text,text,text,text,text,jsonb,text)','EXECUTE') THEN RAISE EXCEPTION 'route planner lacks controlled submit'; END IF;
END
$assert$;
ROLLBACK;
