# S01 Migration and Replay

## Decision

`PASS`

S01 creates isolated ephemeral PostgreSQL databases and proves the complete
migration and replay matrix. The fixtures are removed after each run.

## Verification

- raw SHA-256 locks prove migrations 001–014 remain byte-identical to the v0.2
  baseline;
- a clean database applies migrations 001–032, all 21 SQL assertion suites,
  and a checksum-verified second migration pass;
- databases stopped at the v0.1 boundary (010) and v0.2 boundary (016) retain
  seeded data while upgrading through 032;
- a deliberately failing transactional migration leaves no partial table;
- Reference search and OperationalTask snapshot rebuilds both return exact
  `MATCH` checksums from frozen evidence.

Run with:

```text
DATABASE_ADMIN_URL=<postgresql-admin-url> npm run validate:stable-migrations
```
