# GOWM Network Foundation

This package implements the Data Foundation-owned network build kernel. It is not a Provider graph copy and is not imported by the Gateway.

`CatalogNetworkBuildAdapter` accepts only a pinned `NETWORK` DatasetVersion and an allowlisted set of Catalog layers. Inputs are normalized to integer nanodegrees/millimetres before hashing. Source Features are sorted by stable ReferenceKey/version, so identical DatasetVersion + BuildPolicy inputs produce identical source and graph identity hashes.

`PostgresNetworkCatalogRepository` requires a checked-out `PoolClient` inside one transaction. The caller must begin a transaction before construction, call the adapter, and commit or roll back afterward. This preserves transaction-local `gowm_catalog_v1.set_scope`; passing a pool that may switch connections is intentionally excluded by the constructor type.

The OSM artifact entry point is explicitly `OSM_ARTIFACT_PREVIEW`. It requires a locked artifact SHA-256 and emits non-Stable warnings. It cannot replace the Catalog authority.
