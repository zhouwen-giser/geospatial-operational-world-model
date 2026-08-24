# G04 Grounding Catalog Providers

## Decision

`PASS`

The canonical `gowm.reference-catalog` and `gowm.dataset-catalog` provider
identities now execute through one hardened implementation in two deployment
modes. Their five Reference operations and six Dataset/Layer/Feature operations
use the frozen v0.4 schema bundle and hashes, authenticated Provider transport,
repeatable-read/read-only transactions, versioned SQL read contracts, trusted
DataScope/DatasetScope claims, bounded queries, scope-bound snapshots, and
HMAC-signed stable cursors.

Migration 020 adds the runtime snapshot views and least-privilege service
logins. Migration 021 fixes a real acceptance defect found during HTTP testing:
an exact alias/code/external-id/pinyin match now takes precedence over a
higher-priority source that only matched fuzzily. Scope filtering still occurs
before scoring, ranking, counting, and limiting.

## Real verification

- PostgreSQL 18/PostGIS runtime: all SQL assertions pass, including service-role
  denial on base tables and scope-isolated snapshot resources.
- Fresh database: migrations 001–021 and all ten SQL assertion files pass.
- Live Provider HTTP: both manifests load; ambiguous `复兴路` retains two
  candidates; alias, code, external ID, and pinyin exact modes are preserved;
  batch-get preserves request order; dataset/layer metadata includes truthful
  versions and CRS; two feature pages advance with a signed cursor; `tenant-b`
  sees zero `tenant-a` rows.
- Full repository verification: 90 root tests pass with one intentional skip;
  all 39 STAS tests pass; typecheck, SQL AST validation, and builds pass.

## Acceptance coverage

AC-G003–G017 and AC-G019–G028 are covered at the catalog/read-contract and real
Provider boundary. The real Gateway direct/DAG routes are intentionally closed
in G08, after Derived Results and World Evidence are registered.

The C02 locked-Provider blocker remains unchanged.
