import {describe,it,expect} from 'vitest';
import {projectionConcurrency} from '../../services/projection-worker/src/concurrency.js';
import {projectionFailureReason} from '../../packages/historical-trace-runtime/src/historical-projection-coordinator.js';
describe('bounded projection concurrency',()=>{
 it('allocates two history slots and one slot for each live stage',()=>{
  expect(projectionConcurrency({})).toEqual({history:2,tracklet:1,finalization:1});
 });
 it.each(['0','-1','5','2.5','NaN',''])('rejects invalid history concurrency %s',(value)=>{
  expect(()=>projectionConcurrency({HISTORICAL_REQUEST_CONCURRENCY:value})).toThrow();
 });
 it('allows the supported limits and rejects oversized rebuild/finalization pools',()=>{
  expect(projectionConcurrency({HISTORICAL_REQUEST_CONCURRENCY:'4',TRACKLET_REBUILD_CONCURRENCY:'2',TRACKLET_FINALIZATION_CONCURRENCY:'2'})).toEqual({history:4,tracklet:2,finalization:2});
  expect(()=>projectionConcurrency({TRACKLET_REBUILD_CONCURRENCY:'3'})).toThrow();
  expect(()=>projectionConcurrency({TRACKLET_FINALIZATION_CONCURRENCY:'3'})).toThrow();
 });
 it('categorizes rejected reuse without exposing arbitrary error details',()=>{
  expect(projectionFailureReason(new Error('request evaluation snapshot mismatch'))).toBe('REQUEST_EVALUATION_SNAPSHOT_MISMATCH');
  expect(projectionFailureReason(Object.assign(new Error('postgresql://user:secret@example.invalid/db'),{code:'23514'}))).toBe('SQLSTATE_23514');
  expect(projectionFailureReason(new Error('payload and credentials'))).toBe('PROJECTION_EXECUTION_FAILED');
 });
});
