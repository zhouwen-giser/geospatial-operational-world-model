# P02 Repository framework refactor

Status: **implementation and local verification PASS; delivery PARTIAL**

## Outcome

The Capability Platform was added incrementally alongside the existing GOWM+
runtime rather than replacing it. The repository now has first-class
`contracts/platform`, `contracts/capabilities`, `packages/platform`,
`packages/integrations`, `services/gateway`, `services/providers`, and
`validation` trees. Existing world-model, ingest, projection, World API, MCP,
simulation, and STAS source trees remain in place.

The root npm workspace includes the platform, integration, Gateway, and
Provider packages. Root TypeScript compilation covers all packages, services,
scripts, simulator, and tests; STAS remains an independently built workspace
and is invoked explicitly by the root build/check commands. This preserves the
existing service boundary while ensuring new workspaces cannot silently escape
the root build.

## Verification actually run

| command | result | evidence |
|---|---|---|
| `npm.cmd run build` | PASS | root TypeScript emit followed by the independent STAS build |
| `npm.cmd test` | PASS | 15 files / 71 tests passed; one environment-gated live PostGIS file/test skipped |
| `npm.cmd --prefix services/stas test` | PASS | 39/39 existing STAS tests |
| `npm.cmd run check` | PASS | strict root TypeScript plus STAS typecheck after concurrent slices converged |
| `npm.cmd run validate:boundaries` | PASS | `CAPABILITY_BOUNDARIES_PASS` |

The skipped PostGIS case is not counted as database or runtime proof. P02 does
not have a dedicated numbered acceptance case in the supplied matrix; its
machine report records structure, root-build coverage, legacy-service
continuity, and boundary validation as phase-local checks.

## Evidence classification

- Root build, unit/scenario/platform tests, and STAS tests are actual local
  executions.
- Provider and Gateway tests use controlled in-process runtimes unless a later
  phase explicitly labels an HTTP or database run.
- No live PostgreSQL execution, Docker runtime, or process-restart evidence is
  claimed by P02.

## Delivery status

No P02 semantic commit, push, or Draft PR update was performed. The committed
HEAD remains `e100cc0fd0b7b27f8a386232dc2b261de7841547`; the capability-platform
work is present in the working tree. Git delivery is **BLOCKED** because the
sandbox cannot create `.git/index.lock`, while the authorized escalated Git
operation is unavailable under the current platform usage limit. No alternate
index path, stash, reset, or other workaround was used.
