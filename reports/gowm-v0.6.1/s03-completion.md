# S03 — Final Candidate

Decision: AWAITING_DELIVERY_RECEIPT.

224 effective cases passed; 3 delivery cases pending external receipt; 2 original compatibility cases superseded by the user (not PASS). Zero failed or missing implementation cases.

Current named unit/runtime/conformance evidence: [s03-acceptance.json](s03-acceptance.json). Source fingerprint: `e36a2c67eda8c6d6104ecf67b4de917d118ca31fb53bc009a0a9f20fa3d5bcda`.

D00: 58 migrations / 43 SQL assertion suites. G00: 160 actual Gateway/Provider/PostgreSQL checks. T00: 72 before / 5 after real restart. Provider conformance: 11 current reports, 70 protocol operations; contract/unit evidence is not live readiness. Full static regression: [static-regression.json](static-regression.json).

The [current-design amendment](current-design-amendment.md) supersedes old-wire/data compatibility only. Earlier phase narratives and runtime attempts are historical; the current acceptance JSON, [final report](final-stable-candidate.md), and exact-commit final receipt take precedence. The corrections retain scoped authoritative reads, immutable baseline migrations, and real runtime evidence.

Final delivery is independently checked after commit/push and PR Ready. The PR receipt records the exact SHA. No merge, tag, release, or deployment is authorized or performed.
