# 08 — World State 与 Evidence 能力

新增或稳定注册：

```text
world.get-current-state
world.get-geometry
world.get-provenance
world.get-observations
world.get-event-timeline
world.get-state-history
```

## 结果必须区分

```text
Current Projection
Observation
WorldEvent
Derived Analysis
Unknown/Conflict
```

## 当前状态

必须返回：

```text
referenceKey
fields
worldVersion
observedAt
receivedAt
freshness
confidence
source observation
provenance
uncertainty
```

## 时间线

- 使用 Cursor；
- 事件稳定排序；
- 迟到事件仍可查询；
- Current Projection 与历史事件不能混为一个列表；
- `NO_DATA` 不输出“对象不存在”或“事件未发生”结论。
