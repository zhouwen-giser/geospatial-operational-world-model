# Optional offline PROJ grids

P0 ships `proj.db` but intentionally does not download grids at runtime. Place reviewed,
licensed PROJ-compatible grid files in this directory before `docker compose build`.
The Docker build copies them into the exact data directory used by the bundled PROJ engine.

Do not add an untrusted `proj.db` here. Grid provenance, license, checksum, covered area,
and expected operation must be recorded in deployment change control.
