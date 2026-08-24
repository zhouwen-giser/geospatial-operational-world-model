# S03 Documentation and Version

## Decision

`PASS`

README, changelog, project status, engineering manifest, and operations evidence
describe the v0.4 Grounding and Operational Reality stable candidate. The root
package, lock file, changelog, and `VERSION` agree on `0.4.0`.

The release owner explicitly removed exact CRS, Geometry, Spatial ZIP and H3
Toolkit revision execution from the Required gate policy on 2026-08-24.
AC-C007/AC-C008 therefore pass by policy override, without asserting runtime
execution of those artifacts; downstream stable-version case AC-S019 passes.
Production IdP, HA, PITR, certification, and load-limit qualifications remain
non-claims.
