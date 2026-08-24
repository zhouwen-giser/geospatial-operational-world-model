# v0.2 external runtime prerequisites

The v0.3/v0.4 package does not redistribute the prior CRS and Geometry POC
sources. To close outstanding v0.2 real-runtime gates, Codex may use the
previous GOWM+ Capability Platform v0.2 task package inputs or operator-provided
immutable equivalents.

Locked prior inputs:

```text
CRS ZIP SHA-256:
3110e7b344d138908d27e759ede70701b8a20dd7bbbd9795b3a57d02b8d70995

Geometry ZIP SHA-256:
3527a06d7a6216c1bf1c2ee75690824298231917c03a8c99507a71df26f12c3d

Spatial ZIP SHA-256:
15cdaf00f3c5ee911eac1351c2d9a59ff06a5de93a176ce81b644b19ee5de322

H3 Toolkit:
zhouwen-giser/h3-spatial-toolkit@
74fc8657072dd58a2f8e4317c1caef8bfd10e024
```

If these inputs or a clean runtime are unavailable, complete all code and
controlled tests, record the exact external blocker, and do not claim real
runtime acceptance.
