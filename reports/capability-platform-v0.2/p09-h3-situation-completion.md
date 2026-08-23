# P09 H3 Situation authority refactor

Status: **implementation PASS; phase PARTIAL**

## Outcome

GOWM no longer implements generic H3 primitives inside the Situation package.
`H3SituationIndex` owns only the GOWM-specific R7-R10 projection policy and
delegates cell indexing, cover, hierarchy, neighborhood and boundaries through
`H3KernelPort`. The local integration is locked to H3 Spatial Toolkit 0.3.0 at
`74fc8657072dd58a2f8e4317c1caef8bfd10e024` and its `h3-js` 4.5.0 engine.

The v0.1 function exports remain as compatibility facades, so current World and
Situation callers do not change. Generic results contain no invented World
Version; World Version and Situation metrics remain owned by the projection and
Situation repositories.

## Verification

- H3 delegation, compatibility and C1-C10 scenario tests: **12/12 PASS**.
- Root TypeScript and STAS typecheck: **PASS**.
- Architecture boundary validator: **PASS** and now fails any `h3-js` import in
  `packages/` outside the locked local integration adapter.

## Residuals

- P08 must finish the remote interactive/analysis providers and JS/PG parity.
- The post-change real Docker HTTP compatibility suite is **NOT_RUN** because
  Docker execution requires escalation and the current approval quota is
  unavailable.
- The required phase commit, push and Draft PR update are **BLOCKED** because
  the sandbox cannot write `.git/index.lock` and escalation is currently
  unavailable. No alternate Git-index mechanism was used.
