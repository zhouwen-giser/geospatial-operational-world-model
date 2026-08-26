# P06 — Content-addressed revisions

Profile hashes use canonical declared profiles; semantic catalog hashes use sorted profile entries; contract catalog revision includes the versioned vocabulary and complete descriptor hashes sorted by provider/operation. Binding revision separately includes implementation digest, canonical manifest hash and controlled approval ID. No endpoint, token, health state, order counter or process identity enters contract revision.

Tests prove provider/operation order invariance, reconstructed Gateway registry invariance, changed health/endpoint invariance, input manifest mutation isolation, profile/schema/maturity/vocabulary invalidation, and implementation/approval-only binding changes. All 16 P05/P06 tests pass; actual process restart is additionally required in P11.
