# Foundation capability ports

These interfaces are the only capability boundary intended for synchronous
Foundation ingest and projection work. Implementations are embedded or backed
by the caller's existing database connection; they never discover or call the
Gateway or a remote Provider.

Every successful operation returns a compute-only processing receipt. A receipt
records what code and policy processed an input, but it is not World Evidence
and does not create a World Version.

The v0.2 CRS port deliberately supports only the already-canonical
`EPSG:4326` identity path. A non-canonical source must fail closed until a
legally distributable local CRS core is approved. Remote CRS remains an
external capability and is not an ingest fallback.
