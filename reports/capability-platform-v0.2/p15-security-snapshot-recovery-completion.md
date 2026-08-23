# P15 Security, Snapshot, and Recovery

Status: **implementation PASS; phase PARTIAL**

## Outcome

The World Capability Gateway now fails closed at the security and provenance
boundaries exercised by P15.

- Direct requests cannot carry caller-authored security context. World-query
  validation recursively rejects reserved identity, scope, attestation and
  Gateway-context fields in parameters and every plan value, including nested
  literal bindings, before any Provider call.
- Data-scoped work is independently rejected by both the Gateway and Provider
  SDK when the transport-owned scope is absent. Provider endpoints remain
  approved Registry entries; caller URLs and dynamic operation discovery do
  not change routing. Spatial SQL tests retain hostile strings and Geometry as
  parameters rather than SQL text.
- The Gateway revalidates fresh and idempotently replayed Provider results
  against the selected descriptor. It binds operation, Provider version and
  implementation digest, output schema URI/hash, Compute Snapshot schemas,
  receipt Provider/operation identity and receipt input hash to the controlled
  route and request. A world-independent capability cannot attach a fabricated
  Data Snapshot or World Evidence.
- A cancellation observed after an in-flight node returns now wins the race:
  the late Provider result is discarded, the node is persisted as `CANCELLED`,
  remaining nodes are skipped/cancelled, and no output is assembled.
- Public HTTP errors and durable DAG errors use stable low-cardinality messages
  and recursively redacted details. Provider-health failures expose only a
  stable health detail. Error code, DAG node ID and controlled Provider ID
  remain available, while bearer tokens and raw Geometry/coordinate payloads
  do not appear in the response, health response, stored result or audit event.

The tests also reconstruct new Gateway, Provider and world-query runtime
instances over durable-store abstractions. Same key plus the same payload
replays without Provider work, while the same key plus a different payload
conflicts. This is valid implementation evidence, not a claim of a real
PostgreSQL or process restart.

## Changed artifacts

- `services/gateway/world-capability-gateway/src/direct-execution.ts`
- `services/gateway/world-capability-gateway/src/query-plan-validation.ts`
- `services/gateway/world-capability-gateway/src/query-plan-runtime.ts`
- `services/gateway/world-capability-gateway/src/app.ts`
- `services/gateway/world-capability-gateway/src/registry.ts`
- `services/gateway/world-capability-gateway/src/redaction.ts`
- `services/gateway/world-capability-gateway/src/index.ts`
- `validation/security-snapshot/`
- `reports/capability-platform-v0.2/p15-security-snapshot-recovery-acceptance.json`

No migration, package-lock, P12/P13 report, shared ExecPlan/sync-state, or
Provider implementation file was changed by this P15 slice.

## Verification actually run

| command | result | evidence |
|---|---|---|
| `npx.cmd tsc -p validation/security-snapshot/tsconfig.json --noEmit` | PASS | Scoped P15 TypeScript compilation |
| `npx.cmd vitest run --config validation/security-snapshot/vitest.config.ts` | PASS | 3 files / 14 tests |
| `npm.cmd run test:platform` | PASS | 6 files / 42 tests |
| `npm.cmd run check` | PASS | Root and STAS TypeScript checks |
| `npm.cmd run validate:boundaries` | PASS | `CAPABILITY_BOUNDARIES_PASS` |
| real PostgreSQL idempotency, cross-scope denial and restart | NOT_RUN | Database credentials are unavailable; Docker was not invoked per root coordination |

The 14 scoped tests cover forged direct and DAG identity/scope, Gateway plus
Provider double enforcement, Registry-only routing, SSRF/dynamic-discovery
boundaries, parameterized hostile SQL/Geometry, input and deadline budgets,
in-flight cancellation, durable idempotency replay/conflict, runtime resume,
Compute/Data Snapshot and Receipt/Evidence separation, forged fresh and replayed
result identities, and direct/DAG/audit sensitive-data non-leakage.

## Acceptance

- AC-019: **PARTIAL** — replay and conflict behavior passes across new Gateway
  and Provider instances over a durable-store abstraction; the required real
  PostgreSQL gate was not run.
- AC-058: **PARTIAL** — Gateway and Provider scope enforcement plus SQL
  parameterization pass, but real PostgreSQL cross-scope denial was not run.
- AC-089: **PARTIAL** — restart/resume and idempotency behavior passes over
  shared durable abstractions; no real Gateway/Provider/database restart is
  claimed.
- AC-090: **PASS** — bearer token and raw Geometry/coordinate canaries are
  absent from public direct errors, Provider-health responses, durable DAG
  errors and audit events while code/node/Provider identity remains available.

Machine-readable evidence is in
`p15-security-snapshot-recovery-acceptance.json`.

## Residuals

- P16 must run the PostgreSQL-backed idempotency, exact cross-scope and real
  Gateway/Provider/database restart gates with approved credentials.
- A fixture or in-memory/durable-map abstraction must not be promoted to real
  database or process-restart evidence.
- Docker was not invoked and no commit, push or PR action was performed in this
  delegated slice.
