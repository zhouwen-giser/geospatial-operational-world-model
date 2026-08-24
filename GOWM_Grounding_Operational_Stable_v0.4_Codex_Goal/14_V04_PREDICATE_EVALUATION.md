# 14 — External Predicate Evaluation

External Predicate 来自外部计划或查询，是只读验证输入。

首版 Operator：

```text
IS_INSIDE
IS_NEAR
INTERSECTS
HAS_REACHED
HAS_STOPPED
HAS_OBSERVED
EVENT_OCCURRED
STATE_EQUALS
```

输出：

```text
SUPPORTED
NOT_SUPPORTED
PARTIALLY_SUPPORTED
INDETERMINATE
NO_DATA
CONFLICTING
```

## NOT_SUPPORTED 门槛

仅当：

```text
时间窗有效
观测覆盖充分
关键传感器/数据源健康
存在明确相反证据
```

否则返回 `INDETERMINATE` 或 `NO_DATA`。

## 执行

Predicate Provider 可以通过 Gateway DAG 组合：

```text
world.get-current-state
spatial.*
stas.*
world-event.*
observability.evaluate
```

但 Provider 之间仍不直接互调。
