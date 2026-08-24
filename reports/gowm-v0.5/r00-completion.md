# R00 Route Runtime Completion

Migration 045 adds private Request, Run, Candidate, Segment, Verification and Progress tables under `route_planner_runtime`. The `route_planner_provider` role receives only four controlled functions and no direct table mutation.

The claim function locks the Request, rejects live leases, expires stale Runs, increments the generation and creates one new active Run. Completion must match Request, generation, lease owner and live RUNNING state. Cancellation first makes the Request terminal and cancels its Run, so a late worker completion cannot overwrite it.

Real database `gowm_v05_r00_20260825t0640` applied migration 045 and passed assertion 030. The assertion proved exact idempotent identity replay, generation increment on expired lease reclaim, cancel-vs-late-completion fencing and least privilege. An earlier `0630` attempt exposed an ambiguous PL/pgSQL output-column reference and is not PASS evidence.

Full `AC-R001..AC-R028` remain `NOT_RUN`; R00 proves the persistence/state-machine substrate only. R01 implements planning, R02 independent verification, and R03 immutable result publication/TTL.
