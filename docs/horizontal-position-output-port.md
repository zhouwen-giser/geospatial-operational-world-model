# Current-state horizontal position output port

`world.get-current-state@1.0` additionally publishes the optional output port
`horizontalPositionCoordinates`, exact path `/facts/0/horizontalPositionCoordinates`.
Its schema is `urn:gowm:v0.7.1:horizontal-position-coordinates`: exactly two finite
numbers, longitude in [-180,180], latitude in [-90,90], WGS84 angular degrees.

This is an explicit horizontal projection of the same authoritative current state
already used for `position`. It does not transform CRS, estimate altitude, create
an observation or perform an additional read. Both outputs share the same state
version, Scope-bound transaction, source observation/evidence and DataSnapshot.
No valid position means the field is absent; a dependent DAG must retain normal
missing-output handling, never substitute [0,0].

Original `position`, `positionCoordinates` (`/facts/0/position/coordinates`), raw
state fields and altitude remain unchanged. A 3D position [lon,lat,z] yields the
new [lon,lat] field while retaining all three numbers at the old path. A 2D
position yields the same two horizontal coordinates. The existing generic
world-fact-result schema remains compatible; the new port has its own strict
published schema/hash. The new field changes new output/receipt hashes and the
World Evidence implementation/compute method identity; no old receipt or hash
is rewritten or presented as byte-identical to the new result.

Consumers must refresh the formal capability catalog and exact consumer lock,
bind by the published port name/path/schema hash, and choose this port only for
2D point recipes. Do not truncate an arbitrary JSON path or loosen a destination
schema. Missing capability on an older package is an explicit incompatibility.
Runtime validation by the destination remains mandatory; this port does not
guarantee GDPS coverage, data availability or a successful business result.

The expansion is independent of historical task actor association. No task
association, old event, GDPS schema, data-scope permission or onsite environment
is modified by this change.
