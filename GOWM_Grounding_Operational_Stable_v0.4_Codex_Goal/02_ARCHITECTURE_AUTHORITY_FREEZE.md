# 02 — 架构与权威冻结

```text
GOWM Data Foundation
  ├─ immutable evidence
  ├─ current projections
  ├─ reference/catalog facts
  └─ operational reality events

Capability Service Plane
  ├─ reference/catalog provider
  ├─ world evidence provider
  └─ operational reality provider

World Capability Gateway
  ├─ registry/version/schema
  ├─ scope/budget/idempotency
  └─ direct/DAG/job/result
```

## 权威矩阵

| 领域 | 权威 |
|---|---|
| 真实观测和现实事件 | GOWM+ |
| 当前世界投影 | GOWM+ |
| 世界引用和目录 | GOWM+ |
| 真实活动和物理结果证据 | GOWM+ |
| 计划目标和步骤 | SDAR |
| Action 接收/报告 | SMPP/Provider |
| 用户意图和对话 | SACS |
| 世界语义编译 | 后续 WSGS |

## 禁止

- 将 SDAR phase 写入 OperationalTask 状态；
- 将 Provider completed 直接投影为 VERIFIED；
- 将查询 Predicate 写成事实；
- 将 Correlation inference 写回外部系统；
- 为 WSGS/SACS 引入反向依赖。
