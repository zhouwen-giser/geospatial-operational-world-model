# 20 — 实施阶段

每个阶段必须：实现、实际测试、报告、semantic commit、push、PR 更新。

## C00 Source Reconciliation
对账 `codex/gowm-capability-platform-v0.2`、PR #1、实际 Head、工作树和旧状态文件。

## C01 v0.2 Commit/Report Closure
确保当前实现被 committed/pushed SHA 覆盖，修正陈旧 Git 状态。

## C02 v0.2 Real Runtime Closure
运行 PostgreSQL/Provider/Docker/DAG/Scope/Restart 门禁；无法运行则保留真实阻断。

## C03 Stacked Branch
从准确 v0.2 candidate 创建 `codex/gowm-grounding-operational-v0.4-stable` 和 stacked Draft PR。

## G00 v0.3 Contracts/ADR
冻结 Reference、Catalog、Derived Result 合同和 Provider Manifest。

## G01 Reference Identity Evolution
扩展 entity kind，增加 Descriptor/Name/External ID。

## G02 Dataset/Layer/Feature Catalog
实现版本化 Catalog、Binding 和 Scope。

## G03 Reference Search Projection
精确/别名/拼音/pg_trgm，重建和 Candidate Budget。

## G04 Reference Provider
实现 reference/dataset/layer/feature Gateway Operation。

## G05 Derived Result Registry
实现 ResultReference、DerivedReference、ReferenceSet、TTL、Cursor。

## G06 World Evidence Provider
状态、几何、来源、Observation、Event Timeline。

## G07 v0.3 Security/Replay
Scope 对抗、Search Projection 重建、迁移和恢复。

## G08 Grounding Ready Acceptance
真实 Gateway E2E；标记 `GROUNDING_READY`。

## O00 v0.4 Contracts/ADR
冻结 OperationalTaskEvent/Snapshot、Correlation、Predicate、Observability。

## O01 Correlation Metadata Ingest
Observation/Event 关联字段和 Claim 落库。

## O02 Operational Event Store
不可变事件、去重、晚到、Scope、Outbox。

## O03 Operational Projection
四维状态和重建。

## O04 Correlation Index/Resolver
显式 ID 与受限推导匹配。

## O05 Timeline/Query Provider
OperationalTask/Event 查询能力。

## O06 Predicate Evaluation
首批 Predicate Operator 和 Evidence。

## O07 Observability
Coverage/Watermark/Gap/Source health。

## O08 Correlation Findings
追加式 Findings、冲突、不匹配和重放。

## O09 Operational Reality Provider
全部 Operation 注册到 Gateway。

## O10 Operational Reality Acceptance
真实事件→Snapshot→Correlation→Predicate E2E。

## S00 Contract Compatibility
Schema Hash、v1 兼容、Operation v1/v2。

## S01 Migration/Replay
fresh、v0.1→v0.4、v0.2→v0.4、重建校验。

## S02 Security/Load/Recovery
Scope、并发、迟到、重启、幂等、候选和时间线性能。

## S03 Documentation/Version
更新 VERSION/README/CHANGELOG/PROJECT_STATUS/Runbook。

## S04 Final Stable Candidate
完整 Required Matrix、exact local/remote SHA、PR Ready；不 merge/tag/release/deploy。
