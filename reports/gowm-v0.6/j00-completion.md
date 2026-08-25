# J00 Async Runtime Completion

## Phase / scope

J00 adds the durable Coverage queue lifecycle on top of the existing Gateway Job authority. `coverage_request` and `coverage_run` remain Provider-internal records keyed by `gateway_job_id`; no second public job/status/cancel protocol is introduced.

## Runtime semantics

- Queue admission uses `FOR UPDATE SKIP LOCKED`, a transaction-scoped advisory lock per data/dataset scope, and an explicit maximum running count.
- Every claim is one bounded SQL statement. Heartbeat, canonical-problem persistence, result publication, cancellation, reaping, and reads are also separate controlled statements.
- Solver computation runs between repository calls and cannot retain a database client or transaction.
- Leases are bounded to 1..3600 seconds. Expired runs are fenced as `EXPIRED`, requeued, and reclaimed with a strictly newer generation.
- Heartbeats reject expired/wrong-owner/wrong-generation attempts and reject decreasing progress.
- Cancellation increments generation before terminating the active run, so stale heartbeats and publications fail closed.
- Completed result replay returns the existing request/status/result. A same-key/different-hash submission raises a conflict.
- Gateway connection-pool recreation preserves queued/running state and published result reads.
- A real two-connection cancel/publish race proves exactly one coherent terminal outcome with no ghost result.

## Tests actually run

| gate | result | evidence |
|---|---|---|
| SQL AST | PASS, migrations 001..051 and assertions 001..036 | `npm run verify:sql` |
| fresh and v0.5-upgrade PostgreSQL gate | PASS | `d00-runtime-j00-db-20260825t1305.json` |
| async application/PostgreSQL gate | PASS, 15 checks | `j00-runtime-j00-20260825t1110.json` |
| B00 real selection regression | PASS, 14 checks | `b00-runtime-j00-b00-20260825t1055.json` |
| async worker unit tests | PASS, 3 tests | publish order, idle admission, lost-lease fail closed |
| full repository Vitest regression | PASS, 233 tests | 45 files passed; one pre-existing optional file/test skipped |
| strict build/typecheck | PASS | repository TypeScript and STAS |

The initial database run `j00-db-20260825t1255` failed because requeue progress regressed to zero. Its evidence is retained; `j00-db-20260825t1305` is the successful corrected rerun.

## Acceptance IDs

`AC-J004..AC-J016` are PASS. `AC-J001`, `AC-J002`, and `AC-J003` remain `NOT_RUN` until the real Coverage Provider and Gateway are implemented and exercised in P00/G00; database or direct-client evidence is not substituted for those E2E rows.

## Commit / push / PR

J00 is delivered as a semantic phase commit, pushed, and reflected in Draft PR #4.

## Blockers / next

No J00 runtime blocker. Proceed to P00 Coverage Provider protocol while retaining Gateway Job as the sole northbound lifecycle.
