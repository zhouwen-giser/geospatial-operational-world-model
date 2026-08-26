# P11 — Single-Gateway canaries and isolated repeat

PASS: the identical frozen source passed a second complete run on a fresh,
different task Compose project and PostgreSQL database. Both runs: 662 checks,
30 positive operations, all 21 Stable operations, A–E PASS. The comparison is
machine-recorded in `p11-repeat-acceptance.json`; the previous run remains in
the P10 commit and the current complete HTTP evidence is in `runtime`.

A: Reference → current World position → exact nearby query, including typed DAG.
B: Reference → World geometry → H3 candidate → retained-geometry exact query;
inside, outside, boundary and bbox/H3 false positives independently checked.
C: World → directed Network snap → Route plan → authoritative result validation,
including a typed three-node DAG.
D: pinned LAYER_FEATURE area reference → Coverage plan → result validation,
independent verification and GeoJSON expansion. Appending feature-v2 makes the
old plan snapshot STALE without changing mathematical validity.
E: stop H3 Analysis; Gateway live/ready remain available, inventory degrades,
unrelated Reference/World/Spatial operations succeed, H3 failure is localized,
and contract revision is unchanged. The provider is restarted in a finally block.

A stopped Route provider makes the world-query plan FAILED. Gateway restart
preserves contract revision, persisted job result and idempotent replay identity.
No-data and no-feasible outcomes do not become negative world facts. Foreign
scope references stay opaque. Real provider compiled files match the local
build. Only the Gateway is published; providers/database remain internal.

Optional CRS/Geometry remain unavailable until operator artifacts are supplied;
Situation readiness qualification and STAS Preview are explicit. They are not
used to manufacture Stable readiness. Original user worktree and H3 source are
unchanged; evidence contains no actual task credentials.
