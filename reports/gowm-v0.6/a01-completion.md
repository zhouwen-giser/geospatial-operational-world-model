# A01 Contracts, OpenAPI, Manifest, and Generated Types Completion

## Phase / Scope

A01 installs the 19 authoritative v0.6 JSON Schemas, 10 examples, the five-operation Provider manifest, and OpenAPI description under `contracts/gowm-v0.6`. It extends the repository generator and semantic validator rather than hand-maintaining parallel runtime request types.

## Source state

- Prior pushed SHA and Draft PR head: `823cd7b66803325594ab8ac11fa7fabccbfff0e2`
- v0.6 contract directory is new; v0.5 bytes remain protected by the predecessor guard.

## Contracts / migrations

- 19 schemas retain the task-package canonical LF source-byte SHA-256 values recorded in `a01-contract-lock.json`; `.gitattributes` makes those bytes portable across Windows and Unix checkouts.
- Manifest paths are repository-qualified as `contracts/gowm-v0.6/...`; all eight distinct input/output raw schema attestations match.
- OpenAPI references are normalized relative to `contracts/gowm-v0.6/openapi` and all nine targets exist.
- Generated TypeScript, schema bundle, and canonical hash catalog now include all 19 v0.6 schemas.
- Semantic validation adds bounded EPSG:4326 Polygon/MultiPolygon ring checks, fixed-direction-source rules, alternative-count ordering, and exact QueryResult/DerivedReference kinds.

## Tests actually run

| command | result | evidence |
|---|---|---|
| `npm.cmd run generate:contracts` | PASS | generated TypeScript/bundle/hash catalog updated |
| `npm.cmd run verify:contracts` | PASS | generated artifacts reproduce byte-for-byte |
| targeted road-coverage contract Vitest | PASS | 8 contract/manifest/OpenAPI/example/negative groups |
| `npm.cmd run check` | PASS | repository and STAS typecheck |
| predecessor/source/boundary guards | PASS | no authority or clean-room regression |
| `npm.cmd test` | PASS | 171 tests passed in 35 files; one pre-existing optional skip |

## Acceptance IDs

All `AC-A001..AC-A012` pass after A00+A01. `AC-C001..AC-C012` and `AC-C016` pass. `AC-C013/AC-C014` remain `NOT_RUN_B01` until the actual canonical problem/obligation builders exist; `AC-C015` remains `NOT_RUN_P00` until Provider runtime errors are mapped. No later phase PASS is borrowed here.

## Authority / scope review

The contracts preserve R/E separation, routeCount one, two fixed service modes, three endpoint modes, four boundary policies, exact fixed-point fields, revalidation, and absence of physical/dispatch claims. Unknown and v0.7 fleet/multi-route fields fail closed.

## Failed attempts

- The first mechanical copy used PowerShell `-LiteralPath` with a wildcard, so only OpenAPI and manifest files copied; PowerShell correctly reported both missing literal wildcard paths. The schema/example copy was rerun with `-Path` and the final directory count was verified.
- The first full typecheck found an imprecise TypeScript narrowing around the last Polygon position. The semantic validator was rewritten with explicit first/last locals, then the same typecheck and tests passed.

## Commit / push / PR

A01 is delivered as a semantic phase commit, pushed, and reflected in Draft PR #4.

## Blockers / Next

No A01 blocker. Proceed to D00 append-only Coverage schema, roles, controlled functions, immutability, generation fencing, outbox, assertions, and real PostgreSQL proof.
