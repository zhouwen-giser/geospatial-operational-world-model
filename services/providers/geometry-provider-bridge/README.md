# GOWM Geometry Provider Bridge

This bridge exposes the locked Geometry operation set without changing operation
IDs, request/response schemas, Gateway routing, or authentication. In the default
World Platform deployment it calls the internal Geometry REST upstream at
`http://geometry-upstream:8080` after that service passes readiness checks.

The Geometry POC is project-owned MIT source vendored at
`services/upstreams/geometry-tool-service`. Its source, packages, and image may
be published with the retained LICENSE, NOTICE, SBOM, and source lock. The
original ZIP remains provenance input and is excluded from release artifacts.

Readiness verifies the locked source/OpenAPI digests, GEOS and `geos-wasm`
versions, worker-pool enforcement, approved endpoint digest, and bounded queue
and concurrency configuration.
