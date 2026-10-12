import type { ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { EventRepository } from '../../../packages/runtime/src/event-repository.js';
import type { WorldEvent } from '../../../packages/world-model-core/src/types.js';

export interface StreamFilter { objectType?:string|undefined; eventType?:string|undefined; areaId?:string|undefined; sinceWorldVersion?:number|undefined }
export function eventMatches(event:WorldEvent,filter:StreamFilter):boolean {
  return (!filter.objectType||filter.objectType===event.subject.type) && (!filter.eventType||filter.eventType===event.eventType) &&
    (!filter.areaId||filter.areaId===event.payload.areaId) &&
    (filter.sinceWorldVersion===undefined||event.worldVersion>filter.sinceWorldVersion);
}
export async function writeFrame(response:ServerResponse,frame:string,signal:AbortSignal,timeoutMs=10_000):Promise<void> {
  if(signal.aborted||response.destroyed) throw Error('STREAM_CLOSED');
  if(Buffer.byteLength(frame)>16*1024*1024) throw Error('EVENT_FRAME_BUDGET_EXCEEDED');
  if(response.write(frame)) return;
  await new Promise<void>((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);response.off('drain',drain);response.off('close',close);signal.removeEventListener('abort',close);};
    const drain=()=>{cleanup();resolve();};
    const close=()=>{cleanup();reject(Error('STREAM_CLOSED'));};
    const timer=setTimeout(()=>{cleanup();reject(Error('STREAM_BACKPRESSURE_TIMEOUT'));},timeoutMs);
    response.once('drain',drain);response.once('close',close);signal.addEventListener('abort',close,{once:true});
    if(signal.aborted||response.destroyed) close();
  });
}

/** The durable feed is authoritative. Polling also covers lost broker/NOTIFY wakeups. */
export async function pumpEventStream(repository:Pick<EventRepository,'feedPage'>,response:ServerResponse,options:{
  scope:string;after:string;filter:StreamFilter;signal:AbortSignal;pollMs?:number;pageSize?:number;drainTimeoutMs?:number;
}):Promise<void> {
  let cursor=options.after,heartbeatAt=Date.now();
  while(!options.signal.aborted&&!response.destroyed) {
    const page=await repository.feedPage(options.scope,cursor,options.pageSize??500);
    for(const item of page) {
      if(options.signal.aborted||response.destroyed) return;
      if(eventMatches(item.event,options.filter)) await writeFrame(response,
        `id: ${item.event.eventId}\nevent: ${item.event.eventType.replace(/[\r\n]/g,'')}\ndata: ${JSON.stringify(item.event)}\n\n`,options.signal,options.drainTimeoutMs);
      cursor=item.position;
    }
    if(Date.now()-heartbeatAt>=15_000) {await writeFrame(response,': heartbeat\n\n',options.signal,options.drainTimeoutMs);heartbeatAt=Date.now();}
    if(!page.length) await delay(options.pollMs??250,undefined,{signal:options.signal});
  }
}
