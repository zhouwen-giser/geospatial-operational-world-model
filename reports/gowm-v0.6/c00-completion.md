# C00 Fresh, Upgrade, Replay, and Compatibility Completion

C00 passed a three-path real PostgreSQL matrix with migrations 001–053 and assertions 001–038: fresh install, v0.4 boundary 001–032 to v0.6, and exact v0.5 boundary 001–047 to v0.6. Both upgrade probes were preserved. Replaying the migration runner matched and skipped 53/53 checksums on every path. Deliberately failed transactions left no schema residue, and all three isolated databases were removed.

The T00 recovery artifact supplies result replay evidence: after a real PostgreSQL restart, the deterministic Gateway query replayed byte-equivalently, the Coverage result remained readable, and the durable state remained one Gateway job, one Coverage request, and one result.

The predecessor guard reconfirmed all 47 v0.5 migrations and nine frozen dependency contracts. The Coverage v1 freeze reconfirmed all 19 public JSON Schemas plus the Provider manifest and OpenAPI at the exact A01 hashes. The source-policy guard retained the reference-only, no-redistribution boundary.

Current Network code was measured on the exact committed v0.5 S/M fixture using 40 Snap, 40 Shortest Path, and 20 bounded Matrix samples. Its p95 ratios to the v0.5 candidate were 0.903, 0.886, and 0.909. This is compatibility evidence on an acceptance fixture, not a production SLO claim.

There are no C00 failures, blocks, or deferred required rows. `AC-T014` is PASS; evidence for final rows `AC-F005` and `AC-F006` is ready for F01 aggregation.
