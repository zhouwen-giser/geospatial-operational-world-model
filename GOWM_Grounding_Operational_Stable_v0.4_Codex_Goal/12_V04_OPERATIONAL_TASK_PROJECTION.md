# 12 — OperationalTask Projection

## 身份形成

优先级：

```text
明确 operationCorrelationId
明确 providerAction/deviceCommand
人工确认的执行 Episode
受限推导 Candidate
```

仅凭时间和位置相似度不得自动创建 CONFIRMED OperationalTask；只能生成候选关联。

## 投影规则

- 每次 Event 先持久化；
- Subject/OperationalTask 行锁；
- 依据 eventTime、source priority、confidence、eventId 稳定排序；
- 迟到事件可进入历史，但不能回退较新 Current；
- 终态报告与物理验证维度独立；
- 每次 Current 变更产生投影事件和 worldVersion；
- Snapshot 可由事件全量重建并比较 Hash。

## Current 输出

```text
operationalTask ReferenceKey
actor/target ReferenceKeys
four state dimensions
first/last observed time
freshness
evidence IDs
correlation claim summary
projection policy version
worldVersion
```
