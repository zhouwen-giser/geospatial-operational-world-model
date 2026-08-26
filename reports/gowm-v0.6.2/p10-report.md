# P10 — Actual semantic black-box acceptance

PASS against semantic source digest `sha256:194e266f974e8771fb9ccf38e95fe7db7ec57f78c29c8f66c24a7495a260ac01`.
The materializer and final gate verify this digest against current source.

The isolated single-Gateway run completed 662 checks and exercised 30 positive
operations, including all 21 Stable descriptors. Every Stable operation also
rejects a generated forged schema lock. Results are validated against actual
output schemas, reference kinds, domain-status mappings, receipts and required
snapshots. All eight semantic counters are zero; 21 attestations are PROVEN.

Targeted semantic unit tests: 29 PASS. Full regression was also run before this
commit: 326 Vitest PASS (one pre-existing optional external-DB skip), 40 native
STAS PASS, types/contracts/SQL AST/build/boundaries/provider conformance PASS.
The five canaries, fault isolation and persisted restart/idempotency checks
passed. P11 will repeat these on a second fresh isolated database.

Real integration repairs: typed coordinates and directed state; immutable pinned
Coverage area currentness; Route LOGIN controlled-write transaction mode; frozen
Network source-byte schema hash compatibility. No algorithm, canonical fact or
maturity change. SQL assertion fixtures run in dedicated clean/upgrade databases.
The runtime-image attestation compares compiled provider/Gateway/STAS files with
the local build before accepting HTTP evidence. Ten failed attempts are retained
separately and are never included as passing evidence.

Consumer lock: 21 proven Stable / 99 Preview / no Experimental, generated only
after conformance. Final delivery remains Draft until P11/P12 complete and exact
Git/Ready PR checks pass.
