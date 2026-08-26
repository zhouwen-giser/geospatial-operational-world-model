# P04 — Semantic conformance

Executed 36 rule/DAG tests. All S001–S014 positive and negative cases pass, including SQL comments/literals that must not forge exact predicates, TypeScript sibling import detection, verifier cycles/retired targets, duplicate operations, missing result/snapshot validators, incompatible ReferenceKind and candidate-to-exact DAG rejection before any provider executes.

The conformance CLI validates schema, authority, implementation evidence, cross-capability graph, vocabulary, statuses, freshness, scope, topology leakage and Stable black-box coverage. Source fingerprints invalidate stale black-box evidence. It fails full admission while the 21 Stable operations lack current real black-box receipts. P05 removes the remaining runtime inference implementation; P10/P11 supply runtime evidence.
