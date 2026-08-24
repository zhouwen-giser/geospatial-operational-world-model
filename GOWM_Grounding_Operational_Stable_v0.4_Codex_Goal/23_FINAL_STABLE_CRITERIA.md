# 23 — 最终稳定候选标准

只有全部满足，才能把软件版本设为 `0.4.0` 并输出完成标志：

## v0.2 基础

- Capability Platform 实现有准确 committed/pushed SHA；
- 真实运行门禁通过或所有 Required 环境已经补齐；
- Gateway/Provider/DAG/Scope/Restart 稳定。

## v0.3

- Reference/Catalog 公共合同 v1；
- 同名歧义、Scope、版本、TTL、重放；
- Gateway Operation 真实通过；
- `GROUNDING_READY`。

## v0.4

- OperationalTaskEvent/Snapshot；
- 四维状态；
- Correlation Claim/Finding；
- Predicate Evaluation；
- Observability；
- 迟到事件、冲突、重建；
- `OPERATIONAL_REALITY_READY`。

## 稳定性

- fresh 和两条升级路径；
- 无 Required 失败/未声明跳过；
- exact local/remote SHA；
- Draft PR 转 Ready；
- merge/tag/release/deploy 仍由用户控制。
