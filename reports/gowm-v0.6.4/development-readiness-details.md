# GOWM v0.6.4 development-readiness details

Component implementation and validation are complete: migration 062, deterministic seed, current geometry projection, exact descriptor-to-authority binding, frozen-contract compatibility, fresh-database migrate/seed/start, 12/12 availability, and C1-C4 real canaries all passed.

An exact, clean, local-only qualification candidate at `c00cf03f1f51c18a0b1cf867287c97d20384fd82` was cloned without a remote and verified without a source patch. The clean clone applied migrations 001-062, loaded the authoritative sample seed, reached 12/12 availability, passed the visible/hidden/signed authentication lifecycle, and passed all 36 real canaries. Root tests passed 383 with 1 skipped using one worker, STAS passed 40/40, and the build passed. The default parallel Vitest run exhausted host memory after 353 passing tests; it had no assertion failure, and the complete one-worker rerun passed.

The disposable qualification containers, networks, volumes, and image were removed after their ownership labels were checked. The shared 18063 instance was then reverified at 12/12 availability and 36/36 canaries.

A subsequent shared-runtime regression showed that the LAYER_FEATURE descriptor pin was correctly bound to the active catalog version, but the validation provider compared only the two exposed version strings and reported STALE. The provider now recognizes the exact descriptor-to-active-catalog binding while preserving STALE for historical bindings. Shared 18063 was reverified at 12/12 availability and 37/37 canaries, including the unchanged `reference.resolve(A区)` candidate through `reference.validate`, geometry, and spatial operations.

WSGS R1-R5 consumer smoke also passed against the shared 18063 instance. Both the A-zone chain and vehicle chain consumed the actual `reference.resolve` candidate key unchanged.

Overall status is `DEVELOPMENT_READY`. Implementation commit `b6d5f65dde5e58ba620d1e0a40d3e2323908d588` was published on branch `codex/gowm-v0.6.4-reference-composability`. PR #9 was merged externally at head `fae9e436f2dc2c5be95c1a47462472e3fe0ca464`; this task did not perform that merge. The follow-up LAYER_FEATURE validation repair is published as commit `351ac05e4ba7b75fc203ebfc079e60e98118e419` in Draft PR #10 and is not in `main` at the recorded audit point.

No merge, tag, release, or production deployment was performed by this task or claimed for the follow-up repair.
