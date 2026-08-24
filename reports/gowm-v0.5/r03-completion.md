# R03 Result Publication Completion

Migration 046 adds a Route-specific immutable QUERY_RESULT registry record under the existing world Reference identity system and `gowm_result_v1` scope boundary. One generation-fenced `publish_route_result` transaction persists Candidate, Segment, Verification report, Result identity, routing-snapshot hash, Solver/Verifier versions, TTL, payload hash and terminal Request/Run state. Cancellation or a stale worker generation cannot leave partial artifacts.

The Provider now returns an already-published terminal payload on an identical request instead of recomputing it. Result replay is the stored JSON payload; it does not extend TTL or rewrite historical artifacts. Alternatives remains PREVIEW and the optional distinct-alternative acceptance row is not claimed.

Database assertion 031 passed on isolated database `gowm_v05_r03_20260825t1040`, including publication, scoped lookup, terminal overwrite rejection and Candidate immutability. Real Provider run `r03-20260825t1040` published three requests, three candidates, four segments, three verification reports and three QUERY_RESULT identities. The repeated coordinate request returned the exact hash `sha256:330806d8302ccfebfed2029eeb7d294b90a3dbc22d9d2fc9c4ce88afc7962f4b`.
