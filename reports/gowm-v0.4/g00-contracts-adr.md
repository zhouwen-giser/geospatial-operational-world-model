# G00 v0.3 Contracts and ADR

## Decision

`PASS`

The 27 authoritative v0.3/v0.4 JSON Schemas, four extension Provider
manifests, two OpenAPI documents, and eight canonical examples are now
version-controlled under `contracts/gowm-v0.4` and `contracts/platform/openapi`.
They are bundled by the platform contract runtime with generated TypeScript
types and canonical schema hashes.

ADR 003 freezes identity, authority, scope, catalog, derived-result,
event-sourcing, correlation, predicate, observability, and Gateway boundaries.

## Verification

- all 27 schema IDs are unique and bundled;
- all four extension manifests validate against the authoritative manifest
  schema;
- every manifest input/output hash equals the locked schema-file byte hash,
  while the runtime also exposes a deterministic canonical schema hash;
- five complete canonical examples validate against their contracts;
- ReferenceKey opacity and the four independent operational state dimensions
  are asserted explicitly.

The C02 locked-Provider blocker remains unchanged.
