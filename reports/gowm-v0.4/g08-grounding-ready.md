# G08 Grounding Ready Acceptance

## Decision

`GROUNDING_READY`

The controlled Grounding Gateway registry now locks three canonical Provider
identities and twenty operations to exact full-manifest hashes and
implementation digests. The full manifests are generated deterministically
from the same Provider implementations used at runtime; repository tests reject
any drift between implementation, generated manifest, and deployment lock.

`reference.resolve` declares a safe typed `candidateReferenceKey` output
selector. This enables the real Gateway DAG
`reference.resolve -> world.get-current-state` without Gateway
operation-specific code or untyped JSON extraction.

## Real verification

- Registry bootstrap used the dedicated least-privilege Registry account and
  persisted exactly 3 enabled Providers and 20 enabled operations: Reference 5,
  Dataset 6, and World Evidence 9.
- All three Provider processes passed Gateway health checks and their live
  manifests matched the approved identity/version/implementation/hash locks.
- Direct Gateway routes for `reference.resolve`, `dataset.get`, and
  `world.get-current-state` executed against PostgreSQL-backed Providers.
  Repeating the identical request returned the same envelope with
  `Idempotent-Replay: true`.
- The typed DAG resolved `ROAD-001` to an opaque ReferenceKey and fed it into
  `world.get-current-state`. That authorized road has no current WorldObject
  projection, so the downstream node correctly returned `NO_DATA`; the overall
  query was `PARTIAL`, retained empty facts plus an unknown marker, and replayed
  idempotently without re-executing the Providers.
- A public request that attempted to inject `dataScopeClaim` was rejected by
  the Gateway request contract; trusted Scope remained transport-derived.
- The Gateway process was stopped and recreated. The same previously completed
  direct request replayed from PostgreSQL with `Idempotent-Replay: true`.
  Durable state contains one completed idempotency record and real execution
  receipts from all three Grounding Providers.
- The controlled boundary validator passes, and a source import scan finds no
  WSGS, SACS, SDAR, or A2A dependency in the Grounding/Gateway implementation.

## Acceptance coverage

AC-G018 and AC-G046–G048 pass at the real Gateway/Provider/database boundary.
Together with G00–G07, the v0.3 Grounding Foundation is ready for the v0.4
Operational Reality phases. This status does not waive the unrelated C02
locked-Provider blocker (AC-C007/AC-C008), and does not authorize merge, tag,
release, or deployment.
