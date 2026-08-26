# S00 — Migration / Compatibility

## Scope completed

Fresh install and v0.4/v0.5/v0.6.0 upgrades; seeded v0.6.0 data preservation, checksum replay, rollback, least-privilege roles, and byte-identical predecessor contracts.

## Source state

R00 main `7cd5b133a74b07e28f359176dd13943ab7a6cf54`; isolated candidate branch
`codex/gowm-platform-hardening-v0.6.1`. Runtime source freeze:
[runtime-source-lock.json](runtime-source-lock.json).

## Migrations/contracts

Migrations 001–053 and 103 predecessor contract artifacts are byte-preserved.
New changes are additive in 054–057; v1.0 Coverage wire contracts remain frozen.

## Tests actually run

| Gate | Result | Evidence |
|---|---|---|
| D00 real schema | PASS; 57 migrations / 42 assertion suites / four upgrade paths | [JSON](d00-runtime-v061-r2-final.json) |
| G00 real Gateway | PASS; 150 checks | [JSON](g00-runtime-v061-r2-gateway.json) |
| T00 security/recovery | PASS; 72 before / 5 after restart | [JSON](t00-runtime-v061-r2-recovery.json) |
| C00 compatibility | PASS | [JSON](c00-runtime-v061-r2-compat.json) |

## Acceptance cases

6 Required cases; all PASS in [s00-acceptance.json](s00-acceptance.json).
Cases can appear in more than one integration phase; the final matrix counts
229 unique IDs, never the sum of phase counts.

## Authority/scope/compatibility review

Only dedicated disposable gate databases were mutated. No fact-authority or
Registry/Catalog duplication, no provider-to-provider implementation dependency,
and no Gateway domain algorithm were introduced.

## Failed attempts

See the living ExecPlan. Failed attempts were corrected and rerun; no failed
or unavailable execution is counted as PASS. Real boundary-policy predicates
and full-route E2E are distinct evidence, not interchangeable claims.

## Commit/push/PR

Runtime fixes and PASS evidence are delivered in the semantic integration
commit on PR #6; final exact-SHA/Ready checks are recorded by S03.

## Blockers

None for this gate.

## Next phase

S01 security/recovery/performance.
