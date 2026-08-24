# O00 Operational Reality Contracts and ADR

## Decision

`PASS`

The authoritative OperationalTaskEvent/Snapshot, ExternalCorrelationClaim,
CorrelationFinding, ExternalPredicate, PredicateEvaluation,
ObservabilityAssessment, query/timeline, and `gowm.operational-reality`
Provider contracts were already imported without modification in G00. O00
reconciles each file byte-for-byte with the task package and accepts ADR 004 as
the implementation authority for the v0.4 phases.

The frozen Provider identity is `gowm.operational-reality` version `1.0.0` with
eight Preview operations. Every operation is DataScope-required and requires a
DataSnapshot. No contract equates Provider completion with verified physical
outcome.

## Verification

- all ten Operational schemas and the Operational Reality extension manifest
  byte-match the authoritative task package;
- the generated contract runtime already exposes their canonical types and
  hashes;
- the extension manifest and canonical examples pass the v0.4 contract tests;
- ADR 004 freezes event authority, four-dimensional projection, correlation
  precedence, negative-evidence semantics, replay inputs, and Gateway boundary.

The C02 locked-Provider blocker remains unchanged.
