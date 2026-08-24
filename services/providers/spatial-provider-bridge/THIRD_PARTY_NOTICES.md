# Third-party notices

## Spatial Analysis Service

- Package: `spatial-analysis-service@1.0.0`
- Immutable input: `inputs/spatial-analysis-service-v1.0.zip`
- ZIP SHA-256: `15cdaf00f3c5ee911eac1351c2d9a59ff06a5de93a176ce81b644b19ee5de322`
- License: Apache License 2.0
- Copyright: 2026 spatial-analysis-service contributors

The service was used only as an immutable protocol and behavior reference. The
GOWM repository contains an independently written bridge, canonical contracts,
tests, and evidence; it does not contain the expanded service source, package,
or container image. Deployments that redistribute the locked source input must
retain its Apache-2.0 license text and notices.

## node-postgres (`pg`)

- Package: `pg@8.23.0`
- License: MIT
- Project: https://github.com/brianc/node-postgres

The bridge uses `pg` to access the separately deployed, versioned
`gowm_spatial_v1` read contract.
