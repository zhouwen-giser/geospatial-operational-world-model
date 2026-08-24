# O04 Operational Correlation Resolver

## Decision

`PASS`

External correlation hints are now resolved against scoped, immutable Claim
evidence without changing OperationalTask identity or state. Exact propagated
IDs and Provider declarations outrank manual and inferred evidence; bounded
resource/time inference remains an explicit candidate rather than confirmed
truth. Conflicts and non-matches are persisted, not discarded.

## Implementation

- added migration `028_operational_correlation_resolver.sql` with frozen
  requests, append-only findings/candidates/replay receipts, and scope-first
  lookup indexes;
- encoded precedence as propagated ID > Provider declaration > manual
  confirmation > resource/time match > spatiotemporal inference;
- exact evidence suppresses lower inferred candidates, while multiple highest
  precedence exact task matches produce `CONFLICTING_MATCHES`;
- a bounded actor/time match produces only `POSSIBLY_CORRESPONDS_TO`; an empty
  search produces `NO_MATCH_FOUND` with no fabricated task reference;
- several external steps may resolve to one internal task, and one external
  task may retain several candidate tasks;
- snapshots and external systems are read-only inputs to resolution;
  correlation confidence remains separate from state/projection confidence;
- replay pins the original evidence WorldVersion and method version and compares
  a deterministic resolution hash.

## Verification

- all 17 SQL assertion suites passed on real PostgreSQL;
- `017_operational_correlation_assertions.sql` proves exact operation ID,
  Provider action, many-to-one steps, one-to-many external task conflict,
  bounded inferred candidate, explicit no-match, cross-scope isolation,
  no truth mutation, append-only findings, method/WorldVersion capture, and
  frozen-evidence replay `MATCH`;
- `npm run validate:operational-events` proves Repository/contract runtime
  output for exact `REALIZES / PROVIDER_DECLARED`, `NO_MATCH_FOUND`, and replay
  `MATCH` on the real event → projection → correlation path;
- `npm run verify`: pass — 97 Vitest tests passed, 1 intentionally skipped;
  all 39 STAS tests passed; TypeScript, SQL AST, and production builds passed.

## Acceptance

`AC-O019`–`AC-O030` are `PASS`.

The locked C02 items AC-C007 and AC-C008 remain `BLOCKED_EXTERNAL`.
