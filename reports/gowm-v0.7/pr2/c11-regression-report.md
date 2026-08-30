# Regression report

Status: `PASS` (`P2-R01`, `P2-R02`)

## Exact-source gates

- Canary: `748/748` checks, 34 positive operations; 5/5 named Gateway canaries;
  31/31 source-bound black-box operations; 308/308 compiled files attested.
- Regression: 14/14 command gates PASS.
- Vitest: 176/176 suites; 503 PASS, 9 skipped/pending, 0 failed.
- Materializer: 124 resolved, 0 conflicts, 0 insufficient.
- Registry: 16 Providers, 124 operations, 0 collision/missing/warning.
- Provider conformance: 12/12 Providers; evidence level is contract/unit protocol
  and does not claim runtime readiness.
- Final database: 48 fresh assertions + 3 upgrade assertions; migration count 67,
  head 067; PostgreSQL 18.6, PostGIS 3.6.4, MobilityDB 1.3.0.

## Commands

| Command | Evidence window UTC | Exit | Artifact hash |
|---|---|---:|---|
| `npm.cmd run validate:world-platform-canary -- --env-file <redacted-local-path>` | 09:38:52.817–09:39:32.588 | 0 | `sha256:e2a0a3288af930c4560fe839a68e993dea96f0838a5a6269cc71ddf0d013b7f6` |
| `npm.cmd run validate:world-platform-regression` | 09:40:09.957–09:41:59.841 | 0 | `sha256:22f607cc0d4fb2c8cd90f0d6cc89d0a3cbc131807baf047ac0bbb1abc790d708` |
| `npm.cmd run validate:world-platform-final` | 09:42:29.022–09:44:12.301 | 0 | `sha256:8fc455cb9c94fc2d99077bdd3da1c434a2f7486c26392f03df4d685ad6facb82` |

Working directory for all commands:
`<local-worktree>/gowm-v07-pr2`.
Exact commit: `91e1f030369cd91a8a29308d4ba89bc0339e29f0`.
Semantic source fingerprint remained
`sha256:9a2b4f1629845fc3d7d3807d12baa75f1715c672f3aea2e62abfd7a53404507b`.
The registry/catalog files were byte-revalidated by the exact-head regression;
their older mtime is not treated as a fresh write.
