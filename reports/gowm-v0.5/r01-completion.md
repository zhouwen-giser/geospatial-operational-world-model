# R01 Basic Route Planning Completion

Implemented `gowm.route-planning` with frozen `route.validate`, `route.plan`, `route.plan-alternatives` PREVIEW and `route.verify` registrations. The planner reads only a pinned `gowm_network_v1` snapshot, submits/claims/completes through R00 controlled functions, jointly evaluates snap candidates, and emits immutable-style route candidates with stable signatures.

Ordered Waypoints and Via References are routed in caller order. Avoid References remove every bound Arc before search. Main results contain a QUERY_RESULT ReferenceKey, full RoutingSnapshot, verification report, `validUntil`, and `revalidationRequired=true`; main route geometry remains on-demand through `network.path.expand` as required by the frozen contract.

Real run `r01-20260825t0720` used an ephemeral LOGIN inheriting only `route_planner_provider` against `gowm_v05_r00_20260825t0640`. Coordinate endpoints, an ordered Waypoint, and an Avoid Feature route completed. Frozen Manifest raw-byte locks passed unit verification. The failed `0710` transcript records an incorrect hard-coded DataScope and is not PASS evidence.

R02 owns strict verifier independence/mutation/STALE behavior. R03 owns persisted Candidate/Segment/Verification artifacts, exact idempotent terminal replay and Result Registry publication.
