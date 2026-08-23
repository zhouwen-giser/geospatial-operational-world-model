# GOWM Geometry provider bridge

This original GOWM bridge exposes 19 schema-locked Geometry operations through
the Provider Protocol and delegates only to the registry-approved Geometry Tool
Service endpoint. The upstream request cannot select a URL or route. Execution
uses strict mode, disables implicit repair, and records engine, integration,
precision, coordinate-space unit, schema, input and output provenance in the
standard compute snapshot and receipt.

`geometry.make-valid` is the only repair operation. `geometry.validate` never
repairs or mutates its input. Binary operations require identical coordinate
space and layout. A buffer over `EPSG:4326` requires explicit planar
acknowledgement and is described in angular coordinate-space degrees.

The bridge has its own bounded in-flight/queue admission gate in addition to the
upstream GEOS worker pool. Upstream overload and worker timeout responses map to
retryable Provider Protocol errors. Readiness fails closed unless the attested
`GEOS-WASM-WORKER-POOL` is running with ready workers.

The supplied Geometry Tool Service project intentionally has no selected
project-owner license. Its source, packages and images are not copied or
published by this repository. Only immutable source/OpenAPI digests and the
original bridge code are retained here. Local proof may extract/build the
locked input under ignored `.intake` paths.
