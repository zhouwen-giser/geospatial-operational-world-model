# 19 — 兼容与版本策略

## 合同

稳定后冻结：

```text
gowm-reference/1.0
gowm-dataset-catalog/1.0
gowm-world-evidence/1.0
gowm-operational-task/1.0
gowm-correlation-finding/1.0
gowm-predicate-evaluation/1.0
```

同 Major：

- 只增加可选字段；
- 不改单位和语义；
- 不删除 Enum 值；
- 未知可选字段客户端可忽略；
- 未知 Major fail closed。

## 兼容 API

旧 World/Spatial/Situation API 可保留 Adapter，但新 Reference/Operational Reality 的规范入口为 Gateway Operation。

## 数据兼容

- ReferenceKey 永不复用；
- 名称删除使用 valid_to/retirement event；
- OperationalTask Event 永不更新；
- Current Projection 可重建；
- Result TTL 过期不删除审计记录。
