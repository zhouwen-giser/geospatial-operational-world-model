# GOWM PoC measured benchmark

Run: 2026-08-12T00:42:34.773Z — 2026-08-12T00:42:38.954Z

> Scope: in-process domain/H3 benchmark. It is real measured data, but not a substitute for the supplied PostGIS/h3-pg/MQTT Docker benchmark.

## Spatial core

| Objects | Nearby p95 ms | Within p95 ms | Nearest p95 ms | H3 aggregate ms | RSS delta MiB |
|---:|---:|---:|---:|---:|---:|
| 1000 | 0.14 | 0.21 | 0.78 | 10.08 | 9.5 |
| 10000 | 0.14 | 0.12 | 1.66 | 15.12 | 4.8 |
| 100000 | 0.49 | 1.55 | 2.31 | 106.77 | 2.4 |
| 1000000 | 7.8 | 11.07 | 26.47 | 1041.12 | 15.2 |

## Observation projection

| Observations | Rate/s | Projection p95 ms | RSS delta MiB |
|---:|---:|---:|---:|
| 100 | 13397.31 | 0.11 | 0.1 |
| 1000 | 15383.5 | 0.08 | 12.8 |
| 10000 | 7162.31 | 0.19 | 149.2 |

## Moving objects

| Moving objects | Position rate/s | Current query p95 ms | RSS delta MiB |
|---:|---:|---:|---:|
| 10 | 14648.88 | 0.11 | 0.0 |
| 100 | 26371.51 | 0.01 | 0.0 |
| 1000 | 26598.13 | 0.01 | 0.4 |
| 10000 | 10464.6 | 0.01 | 63.6 |
