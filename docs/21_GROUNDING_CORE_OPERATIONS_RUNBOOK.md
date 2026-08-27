# Grounding Core v0.6.3 Operations Runbook

## Build and validate consumer contracts

```bash
GOWM_REPORT_DIRECTORY=reports/gowm-v0.6.3 npm run build:world-platform-registry
npm run build:consumer-contracts
npm run validate:consumer-contracts
npm run pack:consumer-contracts
```

The pack command only writes a local tarball under the ignored package `dist/`
directory. It never publishes to npm. Compare the manifest `packageIntegrity`
and the v2 WSGS lock before consumer rollout.

## Authentication modes

Leave `GATEWAY_AUTH_MODE=STATIC_SERVICE` for the compatible default. For
`SIGNED_DELEGATION_V1`, configure a pinned issuer, audience, PEM public key, and
TTL no greater than 300 seconds. Rotate keys by deploying a new Gateway config;
never place private keys or signed fixtures in the repository. A delegation
failure is non-retryable and must not fall back to static actor identity.

## Snapshot and availability diagnosis

Inspect `snapshotManifest` and `snapshotAdherence` in the World Query result.
For strict failures, compare the requested resource versions with the Provider
`dataSnapshot`; do not infer cross-process MVCC consistency. For runtime
readiness use `/v1/operation-availability` with normal Gateway authentication.
An isolated Provider failure should affect only its registered operations and
recover after the bounded cache expires.

## Rollback

The code/config rollback is to v0.6.2 with `STATIC_SERVICE`. Migration 061 is
additive and its two immutable JSONB columns can remain during an application
rollback. Do not drop them while v0.6.3 jobs may replay. Consumer rollback uses
the v1 WSGS lock and v0.6.2 contracts; no Provider topology is restored from a
consumer package.
