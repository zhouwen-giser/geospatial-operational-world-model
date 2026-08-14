# Data ownership and access matrix

| Data/capability | Owner | Migration owner | GOWM ingest | GOWM projector | STAS runtime | Diagnostic |
|---|---|---|---|---|---|---|
| Scope, source, stream, pipeline, processing run | GOWM+ | DDL/DML | insert/read | read | contract read | read |
| Observation revisions and heads | GOWM+ | DDL/DML | append/head command | read | contract read | read |
| Time solutions, measurements, uncertainty, provenance | GOWM+ | DDL/DML | append | read | contract read | read |
| AnalysisSpace, CRS, H3, spatial object | GOWM+ | DDL/DML | controlled write | read | contract read | read |
| Sensor, deployment, coverage, status, watermark | GOWM+ | DDL/DML | controlled write | read | contract read | read |
| Tracklet, immutable versions, sequence, gap, lineage, head | GOWM+ | DDL/DML | no direct write | build/head command | contract read | read |
| Current world projection | GOWM+ | DDL/DML | no | write | contract read where declared | read |
| Tool registry | STAS | deployment artifact | no | no | read | read |
| AnalysisRecord and frozen typed input/evidence references | STAS | DDL | no | no | append/read | read |

STAS receives no `INSERT`, `UPDATE`, `DELETE`, or function-execute privilege on
GOWM canonical fact or tracklet build objects. Database constraints validate
scope across frozen inputs and evidence. Immutable evidence tables reject
updates and deletes independently of service behavior.
