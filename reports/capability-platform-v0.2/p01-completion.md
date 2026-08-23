# P01 Completion Report — ADR and contract freeze

## Scope completed

- Accepted ADR-002 for the Capability Platform trust, ownership, dependency,
  receipt/evidence, snapshot, Registry, and typed-DAG boundaries.
- Established strict JSON Schema sources under `contracts/platform` and
  `contracts/capabilities`.
- Split untrusted `GatewayExecuteRequest` from Gateway-attested
  `ProviderExecutionRequest`; the public schema has no identity or scope claim.
- Added deterministic generated TypeScript, runtime schema bundle, and canonical
  schema hash registry.
- Added runtime structural validation with strict formats and semantic validation
  for manifests, catalog approvals/maturity, operation schema attestations,
  Provider attestation windows, result/receipt/snapshot rules, locks, H3
  exactness, and DAG acyclicity/budgets/typed hashes.
- Froze Gateway and Provider Protocol OpenAPI documents, including capability
  detail, health/readiness, async jobs/cancellation, and receipt retrieval.

## Tests actually run

| command | result | evidence |
|---|---|---|
| `npx.cmd vitest run --config validation/gateway-contract/vitest.config.ts` | PASS | 15/15 |
| `npx.cmd tsc -p packages/platform/contract-runtime/tsconfig.json --noEmit` | PASS | exit 0 |
| `node packages/platform/contract-runtime/scripts/generate-contract-types.mjs --check` | PASS | generated artifacts current |
| `npx.cmd tsc -p tsconfig.json --noEmit` | PASS | exit 0 |

## Acceptance cases

AC-009 through AC-014 pass at the contract gate. AC-015 is `PARTIAL`: OpenAPI
schema/path parity is frozen and tested, while route-to-running-service parity
must be rerun after P03/P04/P12 implement all Provider, Gateway, and DAG job
routes. Machine evidence is in `p01-contract-acceptance.json`.

## Security and ownership review

- Unknown fields and unsupported formats fail closed.
- Public bodies cannot assert principal or DataScope.
- Provider manifests cannot supply an absolute routing URL; the approved catalog
  owns endpoint binding and health policy.
- Receipts cannot be encoded as evidence, and world-independent computation
  cannot claim a Data Snapshot or World Evidence.
- Git commit SHA-1 and artifact SHA-256 are separate lock fields and patterns.
- H3 candidate/cover semantics require explicit exact verification.

## Commit/push/PR

Pending the parent phase integrator, which owns the P01 semantic commit, push,
and Draft PR update.

## Blockers

None for the contract slice. Full AC-015 remains scheduled, not blocked.
