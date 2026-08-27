# EP: GOWM+ v0.6.3 Grounding Core Stabilization

This is a living execution plan.

## Source truth

- Package generation baseline: `main@537fd7ec9e73fa7ab945d1ebec7dd3a6913aa9ee`.
- Fetched execution baseline: `origin/main@537fd7ec9e73fa7ab945d1ebec7dd3a6913aa9ee`.
- Baseline version: `0.6.2`; target version: `0.6.3`.
- Isolated branch/worktree: `codex/gowm-grounding-core-stabilization-v0.6.3`.

## Authority boundaries

GOWM remains the authority for world facts, references, data products,
evidence, logical snapshots and capability contracts. The Gateway coordinates
and verifies; Providers remain isolated and receive only Gateway-derived scope.

## Scope exclusions

No WSGS, SACS, SDAR, SMPP or A2A runtime is added. No GIS, STAS, Network,
Route, Coverage, H3 or canonical foundation algorithm is changed. This release
does not claim a production IdP/JWKS, HA, PITR, SLO, registry publication or
deployment.

## Progress

- [x] B00 baseline reconciliation and 0.6.2 regression
- [ ] A00 contract freeze
- [ ] G00 qualification harness
- [ ] G01 reference promotion
- [ ] G02 world evidence promotion
- [ ] G03 catalog/spatial promotion
- [ ] C00 consumer contract package
- [ ] I00 delegation contracts
- [ ] I01 delegation runtime
- [ ] Q00 snapshot contracts/store
- [ ] Q01 snapshot coordinator
- [ ] O00 availability projection
- [ ] O01 availability runtime
- [ ] S00 compatibility/security/recovery
- [ ] F00 documentation/version
- [ ] F01 final stable candidate

## Decisions

- Snapshot means logical resource-version coordination, never a cross-process
  PostgreSQL MVCC snapshot.
- `STATIC_SERVICE` remains the default; `SIGNED_DELEGATION_V1` is opt-in.
- Only the ten frozen Grounding Core operations may be promoted to `STABLE`.
- Consumer contracts are generated from GOWM source contracts and are not a
  second authority.

## Discoveries

- The fetched main exactly equals the package generation commit; no forward
  drift required reconciliation.
- The root `PROJECT_STATUS.md` still described the pre-merge 0.6.2 feature
  branch and required correction.

## Failed attempts retained

- Initial sandboxed `npm ci` could not execute the esbuild binary (`EPERM`).
  The same lockfile install succeeded in the approved execution environment.

## Actual validation

- `npm run verify`: PASS (326 Vitest passed, one optional external DB test
  skipped; 40 STAS tests passed; contract, SQL AST, typecheck and builds pass).
- `npm run validate:world-platform-regression`: PASS (13/13 commands).

## Remaining work

A00 through F01, including real Gateway/Provider/PostgreSQL qualification and
Draft PR delivery.
