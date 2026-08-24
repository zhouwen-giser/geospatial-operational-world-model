# G02 Dataset, Layer, and Feature Catalog

## Decision

`PASS`

Migration 019 adds opaque Dataset, Layer, and Layer Feature identities plus
append-only DatasetVersion, LayerVersion, FeatureVersion, and existing
SpatialObjectVersion binding records. VECTOR and CURRENT_PROJECTION are valid
real kinds; RASTER, ELEVATION, NETWORK, POINT_CLOUD, and TILESET remain honest
contract kinds without fabricated implementations.

`gowm_catalog_v1` filters DataScope and DatasetScope before exposing current
heads, histories, geometry summaries, lineage, source/version, CRS, quality,
and content hashes. The Provider service role has no base-table privilege.

## Acceptance coverage

AC-G019–G027 are covered at the real database/read-contract layer: versioned
vector catalog, future-kind validation, immutable Layer/Feature history,
non-copying SpatialObject binding, dual scope enforcement, lineage metadata,
and stable reference-key ordering for later cursor paging.

The C02 locked-Provider blocker remains unchanged.
