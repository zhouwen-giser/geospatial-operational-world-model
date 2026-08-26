# P01 — Explicit contract freeze

Added ADR 062, Manifest 1.1 independent of execution protocol 1.0, semantic profile/catalog/report/consumer-lock schemas, controlled vocabularies and immutable rules v1. Platform manifest validation conditionally requires every profile for 1.1. Legacy manifests remain parseable without semantic defaults. Embedded duplicate schema IDs from the task examples are replaced by references to one authoritative schema. Existing descriptor constraints remain intact.

Actual checks: `npm run check` PASS; 25 platform test files / 137 tests PASS. Added negative tests for missing profiles, protocol drift, unknown ReferenceKind, relation synonyms, duplicate terms and unknown normalized statuses. No maturity changed. Migration and runtime enforcement follow P02–P05; no claim of completed explicit catalog yet.
