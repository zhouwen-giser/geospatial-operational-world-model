import { ProjectionFenceLostError, type SqlPool } from "./database.js";
import { withProjectionExecution } from "./projection-execution.js";

export async function withRenewedProjectionLease<T>(
  claim: {queueId:string;workerId:string;generation:number;leaseSeconds?:number},
  executionOptions: {leasePool:SqlPool;signal?:AbortSignal},
  renewFunction: "renew_historical_trajectory_projection" | "renew_tracklet_projection" | "renew_tracklet_finalization",
  action: (check:()=>void)=>Promise<T>
):Promise<T> {
    const controller = new AbortController();
    const signal = executionOptions.signal;
    const leaseMs = (claim.leaseSeconds ?? 30) * 1000;
    const leasePool = executionOptions.leasePool;
    let deadline = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | undefined;
    const lost = () => {
      if (!controller.signal.aborted) console.error(JSON.stringify({event:"projection_lease_lost",stage:renewFunction,queueId:claim.queueId,generation:claim.generation}));
      controller.abort(new ProjectionFenceLostError());
    };
    const cancelled = () => controller.abort(signal?.reason ?? new Error("Projection cancelled"));
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
    const check = () => {
      controller.signal.throwIfAborted();
      if (performance.now() >= deadline) throw new ProjectionFenceLostError();
    };
    const renew = async () => {
      controller.signal.throwIfAborted();
      const started = performance.now();
      const result = await leasePool.query<{renewed: unknown}>(`
        SELECT gowm_history.${renewFunction}(
          $1::uuid,$2::text,$3::bigint,make_interval(secs=>$4::double precision)
        ) AS renewed`, [claim.queueId,claim.workerId,claim.generation,leaseMs/1000]);
      if (stopped) return;
      if (result.rows[0]?.renewed !== true) throw new ProjectionFenceLostError();
      deadline = started + leaseMs;
      check();
      clearTimeout(watchdog);
      watchdog = setTimeout(lost, Math.max(1, deadline-performance.now()));
    };
    const schedule = () => {
      timer = setTimeout(() => {
        inFlight = renew().catch(() => { if (!stopped) lost(); }).finally(() => {
          if (!stopped && !controller.signal.aborted) schedule();
        });
      }, Math.max(10, Math.floor(leaseMs/3)));
    };
    try {
      // Verify ownership before loading anything; an expired batch claim cannot
      // be revived. Production uses an independent small pool for renewal.
      await renew();
      schedule();
      return await withProjectionExecution(check, () => action(check));
    } finally {
      stopped = true;
      clearTimeout(timer); clearTimeout(watchdog);
      signal?.removeEventListener("abort", cancelled);
      await inFlight;
    }
}
