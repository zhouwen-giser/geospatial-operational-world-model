# H3 interactive provider

`gowm.h3.interactive.bridge@0.2.0` exposes only the eight generic H3 kernel
operations. It uses the shared locked Toolkit upstream, a 3 s default/10 s
maximum timeout, low-cost synchronous QoS, and a one-million-cell hard limit.

The HTTP Toolkit v0.3.0 upstream supplies index, cover, and neighborhood. A
`LockedExternalH3ToolkitAdapter` must be composed for cells-to-GeoJSON and
hierarchy operations. Construction fails if any allowlisted operation is absent.

No GOWM Situation operation is exposed here. Generic resolution policy and
Situation R7-R10 projection policy remain separate.
