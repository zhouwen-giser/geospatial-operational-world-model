# V00 Independent Verifier Completion

## Phase / scope

V00 adds `@gowm/road-coverage-verifier-core` as a separate package. Its production source imports only frozen contract/runtime primitives and verifier-local types. It imports no Closed/Open DCPP, RPP, strict search, or Solver legality/cost/coverage helper.

## Independent replay

- Authority Arc identity, pinned graph version, directed interval, and physical/state-node continuity are reconstructed from verifier input.
- Pairwise forbidden, allowed-only, multi-Arc forbidden, and penalty rules are independently replayed over collapsed Arc history, including the directed start context.
- Required-pass coverage is recomputed by interval multiplicity sweeps, so split service segments can form one pass while overlaps and duplicates cannot fabricate extra passes.
- Count and length-weighted coverage ratios, required length, and covered required length use independent fixed-point calculations.
- Exact start and endpoint-mode terminal are matched to both route state objects and first/last segment state nodes.
- Boundary policies are replayed from ordered ENTRY/EXIT evidence without importing the endpoint policy helper.
- Profile, condition, speed/risk overrides, segment metrics, turn penalties, route totals, route signature, snapshot hash, and report hash are independently evaluated.
- Admission requires `status=VALID`, every check true, an untampered verification report hash, and an untampered route signature.

## Tests actually run

| gate | result | evidence |
|---|---|---|
| focused independent verifier tests | PASS, 8 tests | valid receipt plus identity, topology, turn, coverage, endpoint, boundary, profile/condition, metric/hash, stale, admission mutations |
| machine verifier/mutation gate | PASS, 22 checks and 12 invalid mutations | `v00-independent-verifier-v00-20260825t1210.json` |
| verifier import scan | PASS | no planning-core or Solver module/helper imports |
| frozen verification-report contract | PASS | valid report includes version, snapshot hash, checks, ratios, metrics, violations, report hash |
| strict build/typecheck | PASS | repository TypeScript and STAS |
| full repository Vitest regression | PASS, 224 tests | 43 files passed; one pre-existing optional test skipped |
| predecessor/source/boundary guards | PASS | exact v0.5 locks, reference-only policy, authority and Gateway boundaries |

## Acceptance IDs

`AC-V001..AC-V017` and `AC-V019..AC-V022` are PASS. Snapshot mismatch logic returns `STALE` in focused and machine gates, but `AC-V018` explicitly requires real end-to-end evidence and remains unclaimed until the Provider/Gateway runtime phase.

## Commit / push / PR

V00 is delivered as a semantic phase commit, pushed, and reflected in Draft PR #4.

## Blockers / next

No verifier implementation blocker. Proceed to L00 alternatives and ensure only independently admitted routes participate in deduplication, diversity, and ranking.
