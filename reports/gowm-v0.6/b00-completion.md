# B00 Area Selection and Fraction Obligation Completion

## Phase / scope

B00 adds a clean-room Road Coverage core and a single narrow Network read-contract extension. Selection always runs after `gowm_network_v1.set_scope`, pins the exact graph/dataset/content hash, and returns only service-eligible directed arcs. Coverage receives no `public` schema usage and no Network Foundation base-table privilege.

## Selection semantics

- `FULLY_COVERED_EDGE` uses boundary-inclusive PostGIS `ST_Covers` over the physical edge.
- `INTERSECTING_COMPLETE_EDGE` selects every legal directed Arc of a touching edge with fractions `0..1,000,000`.
- `CLIPPED_INSIDE_AREA` dumps every disjoint line intersection and converts its endpoints to oriented Arc integer fractions.
- `MANUAL_OBLIGATIONS` validates every external Arc key against the pinned graph and scope, then recomputes canonical identity.
- `BOTH_DIRECTIONS` expands every legal direction into fixed obligations; one-way edges never synthesize a reverse Arc.
- `FIXED_DIRECTION` requires `SOURCE_FEATURE_ATTRIBUTE`, `APPROVED_POLICY`, or manual authority and fails closed when the source is ambiguous.
- Empty selection is explicitly DENY in v0.6. Candidate and minimum-fragment budgets are enforced before publication.

## Tests actually run

| gate | result | evidence |
|---|---|---|
| 10 focused core/contract unit groups | PASS | direction, budget, empty, manual, references, ordering/hash |
| SQL AST 001–050 / assertions 001–035 | PASS | append-only read-contract migration and privilege assertion |
| real PostGIS selection as `coverage_planner_provider` | PASS, 14 checks | `b00-runtime-b00-20260825t0930.json` |
| fresh and v0.5 upgrade database regression | PASS | `d00-runtime-b00-db-20260825t0950.json` |
| repository build/typecheck and frozen contracts | PASS | root build/check |

The real fixture proves invalid geometry rejection, polygon-hole exclusion, MultiPolygon determinism, boundary covers, whole intersecting edges, multiple fractional clips, minimum length, road class, service eligibility, one-way legality, both-direction expansion, scope-first denial, candidate budget, and manual pin validation. Every uniquely named test database was removed.

## Acceptance IDs

`AC-O001..AC-O014` and `AC-O019..AC-O024` are PASS. `AC-O015` remains assigned to P00 real Provider error mapping, `AC-O016` to independent verification, and `AC-O017/AC-O018` to strict routing connectivity. No later-phase claim is borrowed.

## Failed attempts retained

- The first application-container run found the new runtime client absent from the explicit TypeScript compile list; the list was updated and the isolated database was cleaned.
- The next run confirmed the role correctly lacked broad PostGIS/public access. A controlled `gowm_network_v1.coverage_selection_candidates` function was added instead of weakening grants.
- The first controlled-function run returned correct symmetric-hole output; its test incorrectly counted numeric fraction intervals without Arc identity and was fixed.
- The first post-050 database regression retained an old migration-count constant. It was updated to 50/35 and the complete regression passed.

## Commit / push / PR

B00 is delivered as a semantic phase commit, pushed, and reflected in Draft PR #4.

## Blockers / next

No B00 blocker. Proceed to B01 canonical problem construction, ledger evidence, and stable problem/obligation hashing.
