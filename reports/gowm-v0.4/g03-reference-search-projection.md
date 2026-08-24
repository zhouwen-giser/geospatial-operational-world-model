# G03 Reference Search Projection

## Decision

`PASS`

The G01 projection implementation is now exercised with a 120-reference real
PostgreSQL fixture. Rebuild produces an identical 240-row projection on repeat;
same-scope duplicate road names return two candidates; the hard candidate
budget is respected; repeated ordering is stable; and another DataScope sees
no candidates.

The indexed projection remains derived and rebuildable. Source identity,
descriptor, name, alias, code, pinyin, and external identifier records remain
append-only. No vector database or unbounded fuzzy scan was introduced.

## Acceptance coverage

AC-G007–G011: deterministic pinyin/normalized resolution, bounded indexed
pg_trgm search, ambiguity preservation, scope-before-rank/count, and no
cross-scope result leakage.

The C02 locked-Provider blocker remains unchanged.
