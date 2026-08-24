# P12 World Query runtime and persistence

Status: **implementation PASS; phase PARTIAL**

## Outcome

The World Capability Gateway now executes the frozen `WorldQueryPlanV2`
contract as a controlled typed DAG. Submission validation locks every operation
and schema to the Registry, rejects cycles and incompatible ports, verifies
scope/snapshot requirements, and enforces node, aggregate and system budgets
before a provider call. The Gateway remains an orchestrator: it contains no GIS
engine, arbitrary SQL, caller URL or dynamic capability discovery.

The runtime resolves literal, request-path, node-output, ReferenceKey,
dataset-version and artifact bindings; persists queued/running/terminal node
records and canonical input/output hashes; implements fail-fast, explicit
preconditions and partial results; and exposes sync, async, lookup, cancellation
and unified job lookup routes. A node can bind either one canonical request
envelope or construct that envelope from separately typed fields and output
paths; the constructed value is always revalidated against the operation's
full registered input schema. Provider errors retain the node and controlled
provider identity.

Composite bindings may additionally assign a typed leaf to a bounded rooted
JSON Pointer `targetPath`. This supports strict nested inputs without trusting a
caller-supplied request object. The validator rejects target paths on whole
request bindings, preconditions, and query outputs; rejects duplicate and
ancestor/descendant paths, unsafe prototype segments, and depth beyond eight;
and retains both leaf-schema validation and final operation-input validation.
The runtime creates object-only null-prototype containers and fails closed on
any assignment collision.

Migration `013_world_query_runtime_persistence.sql` appends PostgreSQL job,
node and immutable transition persistence plus an atomic `SKIP LOCKED` claim
function. Identity, submission and node-key columns are not updatable by the
Gateway runtime role; only the runtime-owned result/state columns receive
column-level update grants. Application event timestamps are ordered against
one another rather than incorrectly compared with the later database insert
clock.

## Tests actually run

| command | result | evidence |
|---|---|---|
| `npx.cmd vitest run tests/platform/world-query-runtime.test.ts` | PASS | 1 file / 12 tests, including nested targetPath, typed-leaf, full-request, and negative cases |
| `node packages/platform/contract-runtime/scripts/generate-contract-types.mjs --check` | PASS | canonical generated contracts and schema hashes are current |
| `npm.cmd run test:platform` | PASS | fresh aggregate run: 6 files / 47 tests |
| `npm.cmd run check` | PASS | root and STAS TypeScript |
| `npm.cmd run validate:boundaries` | PASS | `CAPABILITY_BOUNDARIES_PASS` |
| `pgsql-parser` over migration 013 and assertion 005 | PASS | 19 migration statements / 1 assertion statement |
| real PostgreSQL migrate/restart/resume | NOT_RUN | isolated endpoint credentials unavailable; Docker escalation quota unavailable |

## Acceptance

`AC-024`, `AC-069`, `AC-070`, `AC-076`, and `AC-077` pass. `AC-078` is
`PARTIAL`: restart/resume behavior is proved across runtime instances over the
same durable-store abstraction and the PostgreSQL schema/store implementation
is present and statically validated, but no fixture or static parse is promoted
to a real PostgreSQL restart claim.

Machine-readable evidence is in
`p12-world-query-runtime-acceptance.json`.

## Residuals

- P13 owns the required CRS/Geometry/H3/Spatial cross-capability DAG evidence.
- P15 owns adversarial scope, restart/idempotency, cancellation race and
  snapshot/receipt integrity gates.
- P16 must apply migrations `011` through `013` to fresh and upgraded real
  PostgreSQL and repeat the restart/resume run.
- The phase commit, push and Draft PR update are **BLOCKED** because this
  sandbox cannot write `.git/index.lock` and the current escalation usage limit
  rejects the authorized Git operation. No alternate Git-index path was used.
