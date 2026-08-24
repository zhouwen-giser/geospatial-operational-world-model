# Foundation local adapters

These adapters implement the synchronous Foundation capability ports without a
network boundary:

- `ExistingGeometryValidationAdapter` wraps the existing GOWM
  `validateGeometry` function and never repairs geometry.
- `Canonical4326CrsNormalizationAdapter` accepts only already-canonical
  `EPSG:4326` geometry and rejects every transformation request.
- `H3PgLocalAdapter` executes parameterized, static h3-pg/PostGIS SQL through
  the transaction-local SQL executor supplied by Foundation.

H3 results are candidate indexes. They never replace exact PostGIS topology or
create World Evidence. External capability bridges can implement the same
operation contracts for interactive use, but are not fallback dependencies of
these adapters.
