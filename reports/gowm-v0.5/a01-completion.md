# A01 Contracts Completion

## Scope completed

Integrated all 19 network/routing JSON Schemas, both Provider extension manifests, three OpenAPI 3.1 documents, and eight examples under the frozen `contracts/gowm-v0.5` tree. Added v0.5 to the contract generator, fixed generated union types that combine base object fields with `oneOf` requirements, regenerated runtime schemas/hashes/types, and made generated-artifact freshness part of `npm run check`.

## Source state

- Previous phase commit: `d8b767a`
- Draft PR: #3

## Migrations/contracts

- 19 schema IDs under `urn:gowm:v0.5:*`
- 2 Provider manifests with exact schema-file SHA-256 locks
- 3 OpenAPI 3.1 files whose references stay inside the v0.5 tree
- 8 examples, including explicit ambiguity and stale-result expectation fixtures
- Generated TypeScript types, schema bundle, and canonical schema hashes

## Tests actually run

| command | result | evidence |
|---|---|---|
| initial `vitest run tests/platform/gowm-v05-contracts.test.ts` | FAIL | test source had a local missing parenthesis; no contract test executed |
| rerun focused contract test | PASS | 4 tests validate schema IDs/types, manifests/hashes, examples, and OpenAPI refs |
| `npm.cmd run verify:contracts` | PASS | generated artifacts match source contracts |
| `npm.cmd run check` | PASS | generated freshness, root TypeScript and STAS typecheck |
| `npm.cmd run verify` | PASS | 124 Vitest tests, 39 STAS tests, all migration/test SQL AST checks, generated freshness, typecheck and build; one pre-existing Vitest case explicitly skipped |

## Acceptance cases

`AC-A001` through `AC-A005` and `AC-A010` pass at the contract/type level. Runtime manifest parity is rechecked when Providers are implemented.

## Network authority/scope review

Every public operation declares `DATA_SCOPE_REQUIRED` and `dataSnapshot=REQUIRED`. Graph build/activate appears only in the protected admin OpenAPI and not in either Provider manifest.

## Source reuse and license review

Contracts come from the user-supplied task specification, not the unlicensed nested reference implementation.

## Failed attempts

The first focused Vitest invocation found a syntax typo in the newly authored test. The typo was fixed and the complete test then passed.

## Commit/push/PR

Draft PR #3 remains Draft. No merge, tag, release, or deployment is authorized.

## Blockers

None for A01.

## Next phase

D00 database image with pgRouting 4.0.1 while preserving MobilityDB and H3.
