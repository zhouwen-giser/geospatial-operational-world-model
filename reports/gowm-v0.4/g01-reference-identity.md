# G01 Reference Identity Evolution

## Decision

`PASS`

Migration 017 extends the existing immutable identity kind constraint without
changing migrations 001–016. It adds append-only descriptor versions, names,
aliases, codes, pinyin, external identifiers, a rebuildable bounded pg_trgm
search projection, and the scope-filtered `gowm_reference_v1` read contract.
The first real-database run found duplicate candidates when one Reference
matched more than one search term; append-only migration 018 now retains only
the highest-priority match per ReferenceKey.

Existing identities receive a non-destructive first descriptor/name version;
their opaque `wrf_…` keys remain unchanged. Provider service roles can read
only the versioned contract, never the Foundation base tables.

## Acceptance coverage

AC-G001–G014 are covered at the database/contract layer, including exact name,
alias/code/external ID/pinyin, bounded fuzzy indexing, ambiguity preservation,
scope-before-rank, match score separate from state confidence, append-only
history, and validity windows. Provider HTTP coverage follows in G04.

The C02 locked-Provider blocker remains unchanged.
