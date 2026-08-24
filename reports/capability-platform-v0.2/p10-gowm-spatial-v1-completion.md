# P10 Public Reference and `gowm_spatial_v1`

Status: **implementation PASS; phase PARTIAL**

Migration 012 supplies the stable `gowm_spatial_v1` boundary used by the
Spatial Provider. It creates append-only opaque `ReferenceKey` identities, four
security-barrier contract views, a trusted transaction-local DataScope setter,
and a dedicated `spatial_provider` role. That role defaults to read-only with
statement/lock timeouts, has explicit revokes on canonical Foundation tables,
and receives only the contract-view/function grants.

The current projection is deliberately described as `CONSISTENT_AT_START`.
Neither migration 012 nor the provider claims that an arbitrary historical
World Version is pinned.

## Verification

| Gate | Result | Evidence |
|---|---|---|
| Spatial static architecture | PASS | `SPATIAL_ARCHITECTURE_PASS` |
| Spatial Provider conformance | PASS | 10/10 tests |
| Root strict typecheck | PASS | TypeScript and STAS |
| Migrations 001-010 immutability | PASS | No byte diff from `d1ff3b8` |
| Live database assertion 003 | NOT_RUN | No DB URL; Docker API access denied |
| Fresh migration / v0.1 upgrade | NOT_RUN | Same runtime blocker |

AC-056, AC-059, AC-061, and AC-086 have complete static/runtime-contract
evidence. AC-057, AC-058, and AC-060 remain PARTIAL because their PostgreSQL
behavior was not observed live. AC-084 and AC-085 remain NOT_RUN.

No migration was added or renumbered in this slice. P11 consumes the existing
012 contract, while migration 013 remains owned by the World Query Runtime
phase.

No commit, push, or PR action was performed in this delegated slice.
