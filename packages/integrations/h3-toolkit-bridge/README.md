# H3 Toolkit bridge

This package is GOWM-owned integration glue for the immutable Apache-2.0
`zhouwen-giser/h3-spatial-toolkit` source lock. It does not contain an H3
algorithm implementation.

Two upstream forms are supported:

- `H3ToolkitHttpClient` calls only the six routes published by Toolkit v0.3.0
  at a registry-approved endpoint.
- `LockedExternalH3ToolkitAdapter` binds the exact Toolkit package API for
  hierarchy and cells-to-GeoJSON operations that v0.3.0 does not expose over
  HTTP. The host supplies the installed external-package functions; no Toolkit
  source is copied into GOWM.

`CompositeH3ToolkitUpstream` can combine those forms. Every delegate must attest
Toolkit `0.3.0`, h3-js `4.5.0`, and Git commit
`74fc8657072dd58a2f8e4317c1caef8bfd10e024` or construction fails closed.

The interactive and analysis provider factories expose disjoint operation
allowlists and QoS. Generic H3 responses never contain World Version, Data
Snapshot, or Evidence references. Polygon cover and coverage outputs are
explicit center-containment candidate sets requiring exact Spatial/PostGIS
verification.
