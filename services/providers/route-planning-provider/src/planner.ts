import { compareUnicodeCodePoints } from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import { NetworkRepository, shortestPath, type DirectedState, type LoadedNetwork, type NetworkProviderOptions, type NetworkSqlPool, type Objective, type Row, type RoutingSnapshot } from "../../../../packages/network-query-core/src/index.js";
import { verifyRouteCandidate } from "./verifier.js";

export interface RoutePlannerOptions extends NetworkProviderOptions { resultTtlMs?: number; }
export interface RouteExecution { output: Row; dataSnapshot: LoadedNetwork["dataSnapshot"]; rows: number; candidates: number; }

export class RoutePlanner {
  readonly network: NetworkRepository;
  private readonly ttlMs: number;
  constructor(private readonly options: RoutePlannerOptions) { this.network = new NetworkRepository(options); this.ttlMs = options.resultTtlMs ?? 300_000; }

  async validate(inputValue: unknown, security: Scope, deadlineMs: number): Promise<RouteExecution> {
    const input = asRow(inputValue); const snapshot = await this.snapshot(input, security, deadlineMs);
    const network = await this.network.loadPinned(snapshot, security, deadlineMs);
    const checks: Row[] = [{ code: "ROUTING_SNAPSHOT", status: "PASS" }, { code: "ENDPOINTS", status: input.start && input.destination ? "PASS" : "FAIL" }];
    return { output: { status: checks.every((check) => check.status === "PASS") ? "VALID" : "INVALID", checks, verifierVersion: "gowm-route-request-validator/1.0.0", verifiedResultHash: sha256(input) }, dataSnapshot: network.dataSnapshot, rows: network.arcs.length, candidates: 0 };
  }

  async plan(inputValue: unknown, security: Scope, deadlineMs: number, alternatives: boolean): Promise<RouteExecution> {
    const input = asRow(inputValue); const snapshot = await this.snapshot(input, security, deadlineMs);
    const network = await this.network.loadPinned(snapshot, security, deadlineMs);
    const submitted = await this.submit(input, security);
    if (submitted.terminal) { const replay = await this.replay(submitted.id, security); if (!replay) throw new ProviderProtocolError("IDEMPOTENCY_CONFLICT", "terminal route result is unavailable"); return { output: replay, dataSnapshot: network.dataSnapshot, rows: network.arcs.length, candidates: arrayOrEmpty(replay.candidates).length }; }
    const run = await this.claim(submitted.id, `sync:${input.requestId}`, Math.max(1, Math.ceil(Math.min(deadlineMs, integer(input.deadlineMs, "deadlineMs")) / 1000)));
    try {
      const locations = [input.start, ...arrayOrEmpty(input.waypoints), ...arrayOrEmpty(input.viaReferences), input.destination];
      const candidateSets: DirectedState[][] = [];
      for (let index = 0; index < locations.length; index += 1) candidateSets.push(await this.resolveLocation(locations[index], snapshot, security, deadlineMs, index === 0 ? input.startHeading : index === locations.length - 1 ? input.destinationHeading : undefined, input.snapToleranceM));
      if (candidateSets.some((set) => set.length === 0)) return await this.finishNoPath(input, network, submitted.id, run);
      const combinations = cartesian(candidateSets, 128);
      const excluded = new Set(network.arcs.filter((arc) => arrayOrEmpty(input.avoidReferences).some((reference) => isRow(reference) && reference.id === arc.sourceFeatureReferenceKey?.id)).map((arc) => arc.key));
      for (const arcKey of await this.network.arcsIntersectingAreas(snapshot, arrayOrEmpty(input.avoidAreas).map(asRow), security, deadlineMs)) excluded.add(arcKey);
      const paths: Row[] = [];
      for (const states of combinations) {
        const path = routeLegs(network, states, objective(input.objective), excluded, deadlineMs);
        if (path.status === "COMPLETED") paths.push(path);
      }
      const distinct = new Map<string, Row>();
      for (const path of paths) { const signature = routeSignature(path); if (!distinct.has(signature)) distinct.set(signature, path); }
      const ranked = [...distinct.entries()].sort(([, left], [, right]) => metric(left, objective(input.objective)) - metric(right, objective(input.objective)) || compareUnicodeCodePoints(routeSignature(left), routeSignature(right)));
      const wanted = alternatives ? Math.min(integer(input.alternativeCount ?? 1, "alternativeCount"), 5) : 1;
      const candidates = ranked.slice(0, wanted).flatMap(([signature, path], index) => { const candidate = { rank: index + 1, routeSignature: signature, segments: path.segments, metrics: path.metrics }; const verification=verifyRouteCandidate(network,candidate); return verification.status==="VALID"?[{...candidate,verification}]:[]; }).map((candidate,index)=>({...candidate,rank:index+1}));
      const status = candidates.length ? "COMPLETED" : "NO_PATH";
      const output = result(input, snapshot, status, candidates, this.ttlMs);
      await this.publish(submitted.id, run.generation, run.owner, output);
      return { output, dataSnapshot: network.dataSnapshot, rows: network.arcs.length, candidates: candidates.length };
    } catch (error) { await this.complete(submitted.id, run.generation, run.owner, "FAILED", null).catch(() => undefined); throw error; }
  }

  async verify(inputValue: unknown, security: Scope, deadlineMs: number): Promise<RouteExecution> {
    const input = asRow(inputValue); const snapshot = routingSnapshot(input.routingSnapshot);
    const network = await this.network.loadPinned(snapshot, security, deadlineMs); const candidates = arrayOrEmpty(input.candidates).map(asRow);
    const freshness = await this.network.inspectFreshness(network, security, deadlineMs); const reports = candidates.map((candidate) => verifyRouteCandidate(network, candidate, freshness));
    const status = reports.some((report) => report.status === "INVALID") ? "INVALID" : reports.some((report) => report.status === "INDETERMINATE") ? "INDETERMINATE" : reports.some((report) => report.status === "STALE") ? "STALE" : "VALID";
    return { output: { status, checks: reports.flatMap((report) => arrayOrEmpty(report.checks)), verifierVersion: "gowm-route-independent-verifier/1.0.0", verifiedResultHash: sha256(input), warnings: reports.flatMap((report) => arrayOrEmpty(report.warnings)) }, dataSnapshot: network.dataSnapshot, rows: network.arcs.length, candidates: candidates.length };
  }

  private async snapshot(input: Row, _security: Scope, _deadlineMs: number): Promise<RoutingSnapshot> { if (input.routingSnapshot) return routingSnapshot(input.routingSnapshot); throw new ProviderProtocolError("INVALID_REQUEST", "useActiveGraph resolution requires an explicit graph key and is unavailable in v0.5 stable requests"); }
  private async resolveLocation(value: unknown, snapshot: RoutingSnapshot, security: Scope, deadlineMs: number, heading: unknown, snapTolerance: unknown): Promise<DirectedState[]> {
    if (isRow(value) && typeof value.arcKey === "string") return [directedState(value)];
    const maximumDistanceM=typeof snapTolerance==="number"&&Number.isFinite(snapTolerance)&&snapTolerance>0?snapTolerance:100;
    const result = await this.network.execute("network.snap.point", { routingSnapshot: snapshot, location: value, ...(heading === undefined ? {} : { headingDegrees: heading }), maxDistanceM: maximumDistanceM, limit: 8 }, security, deadlineMs);
    const output = asRow(result.output); return arrayOrEmpty(output.candidates).map((candidate) => directedState(asRow(candidate).state));
  }
  private async submit(input: Row, scope: Scope): Promise<{ id: string; terminal: boolean }> { const client = await this.options.pool.connect(); try { const hash = sha256(input); const reference = queryReference(hash); const query = await client.query("SELECT route_request_id::text,status,replayed FROM route_planner_runtime.submit_route_request($1,$2,$3,$4,$5,$6::jsonb,$7)", [scope.dataScopeKey, scope.datasetScopeKey, string(input.requestId), string(input.requestId), hash, JSON.stringify(input), reference.id]); const row = query.rows[0]; if (!row) throw new Error("route submission unavailable"); return { id: string(row.route_request_id), terminal: ["COMPLETED","NO_PATH","FAILED","CANCELLED"].includes(String(row.status)) }; } finally { client.release(); } }
  private async claim(id: string, owner: string, seconds: number): Promise<{ generation: number; owner: string }> { const client = await this.options.pool.connect(); try { const query = await client.query("SELECT generation FROM route_planner_runtime.claim_route_request($1::uuid,$2,$3)", [id, owner, seconds]); return { generation: integer(query.rows[0]?.generation, "generation"), owner }; } finally { client.release(); } }
  private async complete(id: string, generation: number, owner: string, status: string, hash: string | null): Promise<void> { const client = await this.options.pool.connect(); try { const query = await client.query("SELECT route_planner_runtime.complete_route_request($1::uuid,$2,$3,$4,$5) AS completed", [id, generation, owner, status, hash]); if (query.rows[0]?.completed !== true) throw new ProviderProtocolError("IDEMPOTENCY_CONFLICT", "route completion lost its generation fence"); } finally { client.release(); } }
  private async publish(id: string, generation: number, owner: string, output: Row): Promise<void> { const client = await this.options.pool.connect(); try { const query = await client.query("SELECT route_planner_runtime.publish_route_result($1::uuid,$2,$3,$4::jsonb,$5,$6,$7,$8) AS published", [id,generation,owner,JSON.stringify(output),sha256(output),sha256(output.routingSnapshot),"gowm-route-product-state/1.0.0","gowm-route-independent-verifier/1.0.0"]); if (query.rows[0]?.published!==true) throw new ProviderProtocolError("IDEMPOTENCY_CONFLICT","route publication lost its generation fence"); } finally { client.release(); } }
  private async replay(id: string, scope: Scope): Promise<Row | undefined> { const client=await this.options.pool.connect(); try { const query=await client.query("SELECT route_planner_runtime.get_route_result($1::uuid,$2,$3) AS result",[id,scope.dataScopeKey,scope.datasetScopeKey]); const value=query.rows[0]?.result; return isRow(value)?value:undefined; } finally { client.release(); } }
  private async finishNoPath(input: Row, network: LoadedNetwork, id: string, run: { generation: number; owner: string }): Promise<RouteExecution> { const output = result(input, network.routingSnapshot, "NO_PATH", [], this.ttlMs); await this.publish(id, run.generation, run.owner, output); return { output, dataSnapshot: network.dataSnapshot, rows: network.arcs.length, candidates: 0 }; }
}

type Scope = { dataScopeKey?: string; datasetScopeKey?: string };
function routeLegs(network: LoadedNetwork, states: DirectedState[], objectiveValue: Objective, excluded: Set<string>, deadlineMs: number): Row {
  const segments: Row[]=[];
  for(let index=0;index<states.length-1;index+=1){
    const history=segments.map(segment=>string(segment.arcKey));
    const leg=shortestPath(network,states[index]!,states[index+1]!,objectiveValue,100_000,false,Date.now,Date.now()+deadlineMs,excluded,history);
    if(leg.status!=="COMPLETED")return leg;
    for(const value of arrayOrEmpty(leg.segments).map(asRow)){
      const previous=segments.at(-1);
      if(previous&&previous.arcKey===value.arcKey&&previous.endFractionPpm===value.startFractionPpm){
        previous.endFractionPpm=value.endFractionPpm;
        previous.turnPenaltyUnits=integer(previous.turnPenaltyUnits??0,"turnPenaltyUnits")+integer(value.turnPenaltyUnits??0,"turnPenaltyUnits");
      }else segments.push({...value});
    }
  }
  const byKey=new Map(network.arcs.map(arc=>[arc.key,arc]));
  const totals={distanceMm:0,durationMs:0,riskMicroUnits:0,energyMwh:0,combinedCostUnits:0};
  for(const segment of segments){
    const arc=byKey.get(string(segment.arcKey));if(!arc)throw new ProviderProtocolError("INVALID_REQUEST","route segment arc is unavailable");
    const span=integer(segment.endFractionPpm,"endFractionPpm")-integer(segment.startFractionPpm,"startFractionPpm");
    const values={distanceMm:fraction(arc.distanceMm,span),durationMs:fraction(arc.durationMs,span),riskMicroUnits:fraction(arc.riskMicroUnits,span),energyMwh:fraction(arc.energyMwh,span)};
    Object.assign(segment,values);for(const name of Object.keys(values) as Array<keyof typeof values>)totals[name]+=values[name];
    totals.combinedCostUnits+=fraction(arc.combinedCostUnits+arc.conditionPenaltyUnits,span)+integer(segment.turnPenaltyUnits??0,"turnPenaltyUnits");
  }
  const core={status:"COMPLETED",routingSnapshot:network.routingSnapshot,segments,metrics:totals,warnings:[] as string[]};return{...core,resultHash:sha256(core)};
}
function result(input: Row, snapshot: RoutingSnapshot, status: string, candidates: Row[], ttlMs: number): Row { return { requestId:string(input.requestId),status,queryResultReferenceKey:queryReference(sha256(input)),routingSnapshot:snapshot,candidates,validUntil:new Date(Date.now()+ttlMs).toISOString(),revalidationRequired:true,warnings:[] }; }
function queryReference(hash: string): Row { return { namespace:"gowm",kind:"QUERY_RESULT",id:`wrf_${hash.slice(7,39)}`,version:"1" }; }
function routeSignature(path: Row): string { return sha256({ segments: arrayOrEmpty(path.segments).map((segment)=>{const row=asRow(segment); return [row.arcKey,row.startFractionPpm,row.endFractionPpm];}) }); }
function metric(path: Row, objectiveValue: Objective): number { const values=asRow(path.metrics); const key=objectiveValue==="SHORTEST_DISTANCE"?"distanceMm":objectiveValue==="FASTEST"?"durationMs":objectiveValue==="LOWEST_RISK"?"riskMicroUnits":objectiveValue==="LOWEST_ENERGY"?"energyMwh":"combinedCostUnits"; return integer(values[key],key); }
function cartesian(sets: DirectedState[][], maximum: number): DirectedState[][] { let result:DirectedState[][]=[[]]; for(const set of sets){result=result.flatMap((prefix)=>set.map((item)=>[...prefix,item])).slice(0,maximum);} return result; }
function fraction(value:number,ppm:number):number{return Number((BigInt(value)*BigInt(ppm)+500_000n)/1_000_000n);}
function routingSnapshot(value:unknown):RoutingSnapshot{const row=asRow(value);return row as unknown as RoutingSnapshot;}
function directedState(value:unknown):DirectedState{const row=asRow(value);if(typeof row.arcKey!=="string"||(row.direction!=="FORWARD"&&row.direction!=="REVERSE"))throw new ProviderProtocolError("INVALID_REQUEST","invalid directed state");return row as unknown as DirectedState;}
function objective(value:unknown):Objective{if(value==="SHORTEST_DISTANCE"||value==="FASTEST"||value==="LOWEST_RISK"||value==="LOWEST_ENERGY"||value==="WEIGHTED")return value;throw new ProviderProtocolError("INVALID_REQUEST","invalid objective");}
function arrayOrEmpty(value:unknown):unknown[]{return Array.isArray(value)?value:[];} function isRow(value:unknown):value is Row{return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);} function asRow(value:unknown):Row{if(!isRow(value))throw new ProviderProtocolError("INVALID_REQUEST","expected object");return value;} function string(value:unknown):string{if(typeof value!=="string"||!value)throw new ProviderProtocolError("INVALID_REQUEST","expected string");return value;} function integer(value:unknown,name:string):number{const number=Number(value);if(!Number.isSafeInteger(number)||number<0)throw new ProviderProtocolError("INVALID_REQUEST",`${name} must be a non-negative integer`);return number;}
