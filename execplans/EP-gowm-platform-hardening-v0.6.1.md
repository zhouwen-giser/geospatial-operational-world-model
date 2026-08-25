# EP: GOWM+ v0.6.1 Platform Hardening

This is a living plan.

## Purpose

Converge Road Coverage correctness, expose machine-readable platform semantics,
and project the existing catalog as scoped public data products without adding a
second authority.

## Actual source lock

- Base: `main@7cd5b133a74b07e28f359176dd13943ab7a6cf54`
- Version: `0.6.0`
- Migrations: 001–053, immutable
- Candidate: `codex/gowm-platform-hardening-v0.6.1`
- Package: `TASK_PACKAGE_VALID schemas=21 semanticProfiles=10 examples=10 acceptance=229`

## Architecture invariants

- Providers consume versioned read contracts through shared core packages.
- Gateway projects registry semantics and orchestrates; it owns no domain algorithms.
- Candidate boundary events are hints, never verification authority.
- Frozen validity, current snapshot currentness, TTL, and execution status remain distinct.
- Data Product and semantic catalogs are projections of existing authorities.
- WSGS, SACS, SDAR, A2A, mock ELEVATION onboarding, merge, release, and deploy are excluded.

## Phase progress

- [x] R00
- [ ] R01
- [ ] C00
- [ ] C01
- [ ] C02
- [ ] C03
- [ ] C04
- [ ] C05
- [ ] C06
- [ ] W00
- [ ] W01
- [ ] W02
- [ ] D00
- [ ] D01
- [ ] D02
- [ ] S00
- [ ] S01
- [ ] S02
- [ ] S03

## Decisions

- R2 cancellation rules override the residual mock-ELEVATION sentence in numbered file 12.
- Public v0.6.1 additions are additive; existing v1.0 contracts remain byte-compatible.
- New database changes start at migration 054.

## Discoveries

- Baseline tests pass when local loopback binding is permitted.
- The v0.6 Coverage claim API still accepts caller-supplied attempts and requires correction.

## Failed attempts retained

- The package validator initially used system jsonschema 3.2.0; an isolated 4.25.1
  environment was used without changing the repository.
- The sandboxed baseline test could not bind loopback; the permitted rerun passed.

## Actual validation

- `bash scripts/preflight.sh .`: PASS
- task validator: PASS (21 schemas, 10 profiles, 10 examples, 229 cases)
- `npm run check`: PASS
- `npm test`: 237 passed, 1 skipped

## Remaining work

R01 through S03.
