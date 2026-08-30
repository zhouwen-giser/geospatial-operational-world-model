# Provider and Gateway report

Status: `PASS` (`P2-P01`, `P2-P02`, `P2-S01`, `P2-A01`)

- Operational interval Provider is `PREVIEW` and declares resource discovery.
- Historical Trace Provider exposes one `history.get-trajectory@1.0` operation.
- One Gateway submission executes the two-Provider DAG.
- The interval node output reference is passed unchanged to the history node.
- Provider HTTP executions: historical 6, interval 1; validation client direct
  Provider calls: 0; Gateway submissions: 7.
- Effective Snapshot pins interval, Tracklet, finalization/watermark and profile
  resources; analysis resource/input-set lineage is append-only and scope-bound.
- Gateway-only validation: `true`; external-model qualification: `false`.

Command/evidence: `npm.cmd run validate:world-platform-final`, UTC
`2026-08-30T09:42:29.022Z`–`2026-08-30T09:44:12.3010375Z`, exit 0,
exact commit `91e1f030369cd91a8a29308d4ba89bc0339e29f0`, isolated PostgreSQL 18.6 /
PostGIS 3.6.4 / MobilityDB 1.3.0. Output excerpt:
`GOWM_V07_PR2_GATE_PASS history-gateway`.
