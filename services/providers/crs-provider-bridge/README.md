# GOWM CRS Provider Bridge

This in-tree service is a protocol bridge, not a CRS engine. It exposes exactly
six registered operations and maps them to the locked
`crs-normalization-service@1.0.0` REST routes. The convenience `/v1/normalize`
route is deliberately absent.

The upstream base URL is startup configuration from an approved Registry
endpoint. Its canonical `{endpointId, baseUrl}` digest must match
`CRS_BRIDGE_ENDPOINT_CONFIGURATION_DIGEST`; execution requests contain no URL,
route, target CRS, PROJ string, vertical datum, grid selector, or raster option.
All successful responses are validated against the POC contract before the
Provider SDK validates the platform result contract.

The deployment must attest the pinned PROJ, `gdal-async`, `proj.db`, and offline
grid-bundle versions/digests. Readiness fails if the live engine differs, if
PROJ network access is enabled, or if strict best-operation policy is disabled.
Execution receipts carry input/output hashes through the Provider SDK and add
machine-readable source/target/axis/version/policy/artifact attestations.

The supplied CRS POC has no project-level license. Its source, package, image,
and expanded files are not GOWM release artifacts. Only this independently
written bridge, schemas, lock metadata, tests, and evidence may be published.
