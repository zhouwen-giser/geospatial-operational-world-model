# P04 Gateway direct execution

Status: **implementation PASS; phase PARTIAL**

## Outcome

The World Capability Gateway now provides controlled Registry resolution,
Provider health aggregation, generic direct execution, dual Gateway/Provider
policy enforcement, idempotency, per-Provider circuit breaking, result and
receipt lookup, and audit emission. Caller requests contain no Provider URL or
trusted identity/scope fields. Registry bindings require explicit approval,
validate the frozen manifest, bind Provider identity to the client, reject
duplicate operation/version routes, and accept only controlled origin URLs.

Migration `011_capability_gateway_persistence.sql` is append-only after the
existing `001` through `010` sequence. It defines Provider/operation Registry,
health observations, Data/Compute Snapshots, Evidence, receipts, execution,
idempotency leases, circuit state/transitions, immutable audit events, indexes,
constraints, recovery functions, and least-privilege roles. PostgreSQL-backed
idempotency, record, audit, and later query-job stores exist, but a static SQL
parse is not promoted to a live migration/restart result.

## Verification actually run

| command | result | evidence |
|---|---|---|
| `npx.cmd vitest run tests/platform/provider-gateway.test.ts tests/platform/provider-sdk-deadline.test.ts` | PASS | 2 files / 10 tests |
| `npx.cmd vitest run --config validation/security-snapshot/vitest.config.ts` | PASS | 3 files / 14 tests |
| `npx.cmd vitest run tests/platform/world-query-runtime.test.ts` | PASS | 1 file / 9 tests |
| `npm.cmd run verify:sql` | PASS | migrations 001–013 and assertions 001–005 parsed |
| `npm.cmd run check` | PASS | strict root TypeScript plus STAS typecheck after concurrent slices converged |
| `npm.cmd run validate:boundaries` | PASS | `CAPABILITY_BOUNDARIES_PASS` |

The platform regression registered one healthy Provider and one not-ready
Provider under separate approved routes. The Registry retained both health
states, and an unrelated healthy direct operation completed while the other
Provider remained not ready.

## Acceptance

- AC-020: **PASS** — only explicitly approved Registry origins and exact
  operation versions resolve; unapproved maturity, caller URLs, alternate
  routes, credential-bearing/query-bearing endpoints, and dynamic discovery
  fail closed.
- AC-021: **PASS** — a not-ready Provider retains its own health state and does
  not prevent an unrelated healthy capability from completing.
- AC-022: **PASS** — a deterministic clock test opens one Provider circuit
  after the configured failure count, rejects calls while open, performs a
  half-open probe after the reset interval, and closes on success without
  affecting another Provider.
- AC-023: **PARTIAL** — idempotency and DAG resume behavior pass across newly
  constructed runtime instances sharing durable-store abstractions, and the
  PostgreSQL stores/schema/recovery functions are present and statically
  validated. No real Gateway/job/database restart was run.
- AC-024: **PASS** — controlled DAG Provider failure persists the exact node ID,
  controlled Provider ID, stable platform error code, and retryability; P15
  redaction retains those identities while removing sensitive payload data.

Machine-readable evidence is in
`p04-gateway-direct-execution-acceptance.json`.

## Evidence classification and residuals

- Registry, direct execution, circuit, audit, health isolation, and node error
  tests are controlled in-process integrations.
- SQL verification is AST/static validation only.
- Real PostgreSQL migration/assertions, durable idempotency, Gateway/Provider/DB
  restart, and HTTP-container acceptance are `NOT_RUN` here and remain P16
  gates.

No P04 semantic commit, push, or Draft PR update was performed. The committed
HEAD remains `e100cc0fd0b7b27f8a386232dc2b261de7841547`. Git delivery is
**BLOCKED** because the sandbox cannot create `.git/index.lock`, while the
authorized escalated Git operation is unavailable under the current platform
usage limit. No workaround was used.
