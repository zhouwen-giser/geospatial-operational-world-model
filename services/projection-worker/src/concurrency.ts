export function projectionConcurrency(environment:NodeJS.ProcessEnv=process.env) {
  const read=(key:string,fallback:number,max:number)=>{
    const value=Number(environment[key]??fallback);
    if(!Number.isSafeInteger(value)||value<1||value>max) throw Error(`${key} must be between 1 and ${max}`);
    return value;
  };
  return {
    history:read("HISTORICAL_REQUEST_CONCURRENCY",2,4),
    tracklet:read("TRACKLET_REBUILD_CONCURRENCY",1,2),
    finalization:read("TRACKLET_FINALIZATION_CONCURRENCY",1,2)
  };
}
