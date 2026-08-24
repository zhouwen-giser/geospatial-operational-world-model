# S02 Security, Load, and Recovery

## Decision

`PASS`

This phase uses two isolated DataScopes, real PostgreSQL contracts, concurrent
event writers, fresh repository/projector instances, and a real database
container restart.

## Required evidence

- cross-scope name resolution returns no foreign-scope reference, and
  cross-scope OperationalTask/event reads return empty results;
- signed cursor tampering is rejected and public error details redact tokens,
  geometry, coordinates, and names;
- the bounded exact Reference query uses
  `reference_search_projection_scope_exact_idx`;
- scoped timeline p95 and projection lag are measured and enforced against
  local stability targets (250 ms and 2 s respectively);
- eight concurrent retries produce one accepted event and seven exact
  duplicates;
- a late control event cannot regress the newer projected state;
- a fresh projector drains pending work once and a second restart produces no
  duplicate projection;
- after a real PostgreSQL container restart, fresh Reference and Operational
  repositories recover the persisted records.

Measured in the accepted run: timeline p95 was `18.967 ms` over 60 reads,
initial projection was `22.540 ms`, and restarted-projector lag was
`14.892 ms`. These are local stability measurements, not production SLO or
capacity claims.

Run with:

```text
DATABASE_URL=<postgresql-url> GOWM_DB_CONTAINER=<exact-container-name> \
  npm run validate:stable-runtime
```
