# R02 Independent Verifier Completion

The Route verifier is implemented in a module that imports only frozen types and hashing/error primitives; it does not import or call the Solver engine or its legality/cost helpers. It independently replays Arc identity/version, continuity, directed Arc validity, partial fractions, pairwise/multi-edge Turn rules, segment and aggregate fixed-point metrics, and Route Signature.

Differential unit tests reject mutated distance/time/cost totals and an inserted forbidden Turn sequence. The architecture gate scans the verifier source and fails on a Solver implementation import.

Real run `r02-20260825t1020` used an ephemeral LOGIN inheriting only `route_planner_provider` against `gowm_v05_r00_20260825t0640`. A route pinned to graph `p01-20260825t0610` and its baseline Condition Snapshot remained verifiable but returned `STALE` after a newer Condition Snapshot and another active Graph existed. The historical result hash remained `sha256:385536173c1e089b44fdaf0e4d91d0bb476ce2c4dbb93dd51e0f0559cfacecf9`; metric mutation returned `INVALID`.

R03 owns atomic persistence of Candidate/Segment/Verification artifacts, Result Registry publication, and exact idempotent terminal replay.
