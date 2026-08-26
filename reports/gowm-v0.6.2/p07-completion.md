# P07 — Controlled unified Registry

The deterministic builder discovers all canonical registry fragments and validates their manifest identity/hash locks, approval metadata and explicit Manifest 1.1. A machine-readable policy names 13 required and 2 optional providers and excludes Observation write, device command, SDAR/A2A, dynamic MCP discovery and arbitrary SQL. Canonical ownership is unique for all 122 operations.

The build fails on missing required providers, unknown provider IDs, duplicate fragments, operation collisions, manifest hash drift, legacy manifests or incomplete exclusions. Missing optional bridges produce warnings. No generated entry is maintained by hand.

Executed the 14-test Gateway/registry suite, including order invariance and every negative builder case. Generated report: world-platform-registry-build-report.json. Runtime health remains a separate gate.
