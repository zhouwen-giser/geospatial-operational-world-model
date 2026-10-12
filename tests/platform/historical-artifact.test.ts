import {describe,expect,it} from 'vitest';
import {IdempotencyCache} from '../../packages/platform/provider-sdk/src/idempotency.js';
import {createHistoricalTraceProvider} from '../../services/providers/historical-trace-provider/src/provider.js';
import type pg from 'pg';

describe('immutable historical Artifact protocol',()=>{
  it('publishes separate operations without extending the frozen preview output',()=>{
    const provider=createHistoricalTraceProvider({pool:{} as pg.Pool});
    expect(provider.runtime.manifest.capabilities.map(c=>c.operationId)).toEqual([
      'history.get-trajectory','history.open-trajectory-artifact','history.read-trajectory-artifact'
    ]);
    expect(provider.runtime.manifest.capabilities.every(c=>c.scopePolicy==='DATA_SCOPE_REQUIRED')).toBe(true);
  });
  it('rechecks settled expiry-sensitive operations while preserving in-flight single flight',async()=>{
    const cache=new IdempotencyCache<number>();let release!:()=>void,calls=0;
    const action=async()=>{calls++;await new Promise<void>(r=>{release=r;});return calls;};
    const first=cache.execute('same',{page:0},action,false);
    const second=cache.execute('same',{page:0},action,false);
    expect(first).toBe(second);await Promise.resolve();release();expect(await first).toBe(1);
    expect(await cache.execute('same',{page:0},async()=>++calls,false)).toBe(2);
    expect(()=>cache.execute('same',{page:1},async()=>99,false)).toThrow('different input');
  });
  it('preserves default cached behavior and does not cache failed reads',async()=>{
    const cache=new IdempotencyCache<number>();
    expect(await cache.execute('old',{},async()=>1)).toBe(1);
    expect(await cache.execute('old',{},async()=>2)).toBe(1);
    await expect(cache.execute('expiry',{},async()=>{throw Error('ARTIFACT_EXPIRED');},false)).rejects.toThrow('ARTIFACT_EXPIRED');
    expect(await cache.execute('expiry',{},async()=>3,false)).toBe(3);
  });
});
