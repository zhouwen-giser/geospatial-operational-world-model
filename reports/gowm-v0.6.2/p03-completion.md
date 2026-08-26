# P03 — Provider Manifest migration

All 15 formal providers / 122 operations declare Manifest 1.1 and an explicit provider-owned semantic profile; Provider Execution Protocol remains 1.0. The offline scanner binds profiles to actual schema/port, TypeScript, SQL AST and test bytes. Repeated generation and runtime factory comparison pass. No maturity was silently changed.

STAS now has a thin, PREVIEW-only protocol adapter for its 15 existing tools. It validates the native data-scope tenant before executing native analysis, preserves native status and actual database snapshot, and keeps the native compiler/build and algorithm implementation. Native OpenAPI schemas are exported deterministically with source hashes; Zod validation remains authoritative for refinements.

Spatial boundary predicates explicitly use boundary-inclusive ST_Covers; distance predicates use WGS84 geography spheroid metres. H3 covers remain candidates with retained-original-geometry verification mapping. No synthetic exact geometry is inferred from a cell set.

Verification in the development worktree: 163 platform tests; root/native STAS typechecks; deterministic materializer; canonical runtime manifest parity. Current Gateway changes are delivered in the following P04–P06 commits. All 21 Stable operations still have BLOCKED black-box attestations until P10/P11 real execution. This is not a Stable readiness claim.
