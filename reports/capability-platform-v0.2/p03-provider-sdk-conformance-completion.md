# P03 Provider SDK and conformance

Status: **implementation PASS; phase PARTIAL**

## Outcome

The Provider SDK centralizes the frozen Provider Protocol mechanics without
embedding a GIS engine or a provider-to-provider client. It validates manifest
and handler parity, operation schema hashes, strict input schemas, trusted
scope, deadlines, cost and resource budgets, output schemas, canonical
receipts, Compute Snapshots, and Receipt/Evidence/Data Snapshot separation.

The conformance kit invokes an actual Provider runtime and tests valid work,
manifest routing, strict schema locks, unknown fields, deadline expiry, output
budget, scope policy, receipt/snapshot semantics, idempotent replay, and
same-key/different-payload conflict. `elevation.sample.mock@1.0` is a separate
Provider package with its own manifest, HTTP application, Dockerfile, canonical
input/output contracts, method identity, Compute Snapshot, and receipt. The
Gateway registers and executes it through generic Provider Protocol code; no
elevation-specific Gateway branch was added.

## Verification actually run

| command | result | evidence |
|---|---|---|
| `npx.cmd vitest run tests/platform/provider-gateway.test.ts tests/platform/provider-sdk-deadline.test.ts` | PASS | 2 files / 10 tests |
| `npx.cmd vitest run --config validation/security-snapshot/vitest.config.ts` | PASS | 3 files / 14 tests |
| `npm.cmd run check` | PASS | strict root TypeScript plus STAS typecheck after concurrent slices converged |
| `npm.cmd run validate:boundaries` | PASS | `CAPABILITY_BOUNDARIES_PASS` |

These are controlled local/in-process executions. They are not real
PostgreSQL, remote Provider, container, or process-restart evidence.

## Acceptance

- AC-016: **PASS** — runtime construction requires exact manifest/handler
  parity and canonical input/output schema hashes; the elevation conformance
  invocation passed all checks.
- AC-017: **PASS** — the delayed Provider aborts and reports
  `DEADLINE_EXCEEDED`; a separate regression proves deadlines beyond Node's
  maximum single timer delay are rescheduled rather than collapsed to 1 ms.
- AC-018: **PASS** — the Provider rejects an actual output over the effective
  budget, and the Direct Gateway independently rejects an oversized response
  from a deliberately non-conforming Provider. The same validation is applied
  again after idempotent lookup before any fresh or replayed result is returned.
- AC-019: **PARTIAL** — replay and conflict semantics pass in the process-local
  Provider cache and across newly constructed Gateway/runtime instances over a
  shared durable-store abstraction. The required PostgreSQL-backed execution
  was not run.

Machine-readable evidence is in
`p03-provider-sdk-conformance-acceptance.json`.

## Residuals and delivery

P16 must run same-key replay/conflict against real PostgreSQL and repeat it
across actual Provider/Gateway/database process restarts. A memory cache or
durable test abstraction is not promoted to that gate.

No P03 semantic commit, push, or Draft PR update was performed. The committed
HEAD remains `e100cc0fd0b7b27f8a386232dc2b261de7841547`. Git delivery is
**BLOCKED** because the sandbox cannot create `.git/index.lock`, while the
authorized escalated Git operation is unavailable under the current platform
usage limit. No workaround was used.
