# O09 Operational Reality Provider

## Decision

`PASS`

The independently deployable `gowm.operational-reality` Provider is registered
as the fourth controlled Grounding Gateway Provider. Gateway remains routing,
policy, DAG, and idempotency infrastructure; OperationalTask projection,
correlation, predicate, and observability logic stays in Foundation/Provider
repositories and SQL contracts.

## Implementation

- registered eight frozen v1 operations with canonical schema hashes, scope
  policy, snapshot policy, resource limits, and compute provenance;
- implemented direct task find/get/timeline, correlation-based task/event
  lookup, correlation resolution, predicate evaluation, and observability;
- added authenticated Provider HTTP transport, health/readiness endpoints,
  runtime configuration, container image, and controlled Gateway binding;
- extended deterministic manifest synchronization and registry checksum checks;
- preserves Provider identity on node failures and rejects missing authorized
  DataScope before execution.

## Verification

- manifest tests prove all eight operations use canonical v0.4 schema hashes
  and that the controlled registry contains four Providers / 28 capabilities;
- `npm run validate:operational-provider` starts real loopback HTTP Provider and
  Gateway listeners against real PostgreSQL and proves direct task get,
  exact correlation, supported predicate, fresh observability, byte-identical
  Gateway idempotency replay, and Provider identity on a failed request;
- `node --import tsx scripts/sync-grounding-provider-contracts.ts --check`
  proves generated manifests and registry digests are current.
- `npm run verify` passes 117 Vitest assertions (one declared environment skip),
  all 39 STAS assertions, SQL AST validation, type checking, and production
  builds.

O10 adds the full multi-node DAG, durable cancellation/restart, and Operational
Reality ready gate. The later 2026-08-24 release-owner policy override records
AC-C007 and AC-C008 as PASS without claiming runtime execution of the waived
artifacts.
