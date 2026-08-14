# Future service boundaries

This release provides shared foundations only; it does not implement the future
services below.

| Future service | Reused foundation | Explicit boundary |
|---|---|---|
| Spatial Analysis Service | SpatialObject versions, AnalysisSpace, geometry indexes, scope, provenance, AnalysisResult | Owns derived spatial analyses, never canonical observations |
| H3 Spatial Toolkit/Service | h3-pg, resolution policy, cell/time buckets, coarse candidate discovery | H3 is lossy indexing/aggregation, never exact geometry truth |
| Geometry & CRS Service | CRS registry, transformation provenance, geometry validation, axis/unit/area-of-use policy | Production CRS certification is separate from synthetic test CRS |
| Route Analysis Service | versioned road/network/terrain objects, restrictions, AnalysisSpace, evidence results | No complete pgRouting/GraphHopper replacement or multi-vehicle planning in v0.1.0 |

Entity resolution, cross-source ReID decisions, relation/intent inference,
embeddings, UI/GIS dashboards, and Kubernetes production topology are also out
of scope until the foundation and STAS P0 gates are complete.
