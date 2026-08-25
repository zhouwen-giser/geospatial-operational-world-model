# D00 Coverage Database Completion

## Phase / scope

D00 adds only migrations 048 and 049 after the byte-locked v0.5 set. The new private `coverage_planner` schema stores requests, immutable canonical problems and obligations, generation-fenced runs, candidates, independently produced verification reports, immutable results/alternatives, progress, and atomic outbox events. It creates no second network graph authority.

## Database and authority result

- 16 scope-bound Coverage tables exist; all public/runtime rows carry both `data_scope_key` and `dataset_scope_key`.
- The Provider can read the frozen `gowm_network_v1` contract and execute exactly seven security-definer lifecycle APIs. It has no direct Coverage table mutation and no Network Foundation mutation.
- Canonical problems, obligations, candidates, routes, segments, verification reports, results, alternatives, similarities, and progress records are immutable.
- Stored fractions are fixed-point integers bounded to `0..1,000,000`; v0.6 persists only route index 1.
- Lease generations fence stale workers. Result publication and its outbox event commit atomically.

## Tests actually run

| command / path | result | evidence |
|---|---|---|
| `npm.cmd run verify:sql` | PASS | 49 migration ASTs and 34 assertion ASTs |
| `npm.cmd run validate:gowm-v06-boundaries` | PASS | no second graph/provider HTTP/authority violation |
| fresh database 001–049 then assertions 001–034 | PASS | `d00-runtime-d00-20260825t0850.json` |
| v0.5 database 001–047, preservation marker, 048–049, assertions 001–034 | PASS | marker remained `v0.5-preserved` |
| deliberate failed migration on both paths | EXPECTED_FAIL / rollback PASS | no residual schema in either database |
| injected outbox insert failure | EXPECTED_FAIL / atomicity PASS | no ghost result, outbox, or terminal request state |
| stale generation publication | REJECTED | no result created by late worker |

Both uniquely named temporary databases were removed by the gate. The validated composite PostgreSQL container and unrelated databases were retained.

## Acceptance IDs

`AC-D001..AC-D018` are PASS with actual PostgreSQL evidence. No later solver, Provider, Gateway, performance, or final-candidate claims are borrowed.

## Failed attempts retained

- The first runtime implementation made hundreds of Docker `exec` calls. It was stopped, its exact isolated database was confirmed and removed, and the same SQL was batched to avoid Docker Desktop startup overhead.
- The first completed batch found that new permission assertions referred to `network_foundation.network_arc`; the established v0.5 authority table is `public.network_arc`. The probes were corrected and rerun.
- The next run passed migrations/assertions but exposed an incorrect summary expectation of eight functions. The schema has two private trigger functions plus seven controlled APIs, so the final gate asserts nine total and exactly seven Provider-executable functions.

## Commit / push / PR

D00 is delivered as a semantic phase commit, pushed, and reflected in Draft PR #4.

## Blockers / next

No D00 blocker. Proceed to B00 area selection and exact fractional obligation derivation, followed by B01 canonical problem/ledger hashing.
