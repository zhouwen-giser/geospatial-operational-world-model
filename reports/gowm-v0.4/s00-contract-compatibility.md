# S00 Contract Compatibility

## Decision

`PASS`

The stable lock records all 33 authoritative task-package artifacts: 27 JSON
Schemas, four extension Provider manifests, and two OpenAPI documents. The
validator hashes installed bytes without reading the extracted task package,
so later drift is detected from repository state alone.

## Verification

- `node validation/scripts/stable-contract-compatibility.mjs` proves all 33
  byte hashes and all extension Operation versions are exactly v1;
- `tests/platform/gowm-v04-contracts.test.ts` validates the complete schema
  bundle, examples, opaque ReferenceKeys, and four independent task states;
- `tests/platform/provider-gateway.test.ts` proves v1/v2 Operation versions can
  coexist and unapproved maturity remains fail-closed;
- the full repository verification suite remains green.

No locked v1 schema, unit, enum value, or semantic role was changed.
