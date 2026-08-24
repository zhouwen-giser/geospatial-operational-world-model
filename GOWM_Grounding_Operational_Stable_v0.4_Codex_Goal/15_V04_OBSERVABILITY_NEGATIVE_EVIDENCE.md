# 15 — Observability 与负面证据

## 目标

区分：

```text
没有观测数据
观测存在空档
数据陈旧
覆盖充分但没有目标
存在明确反证
```

## ObservabilityAssessment

输入：

```text
subject/reference set
time window
expected sources/sensors
coverage geometry
freshness SLA
```

输出：

```text
FRESH
STALE
OBSERVATION_GAP
NO_DATA
COVERAGE_SUFFICIENT
COVERAGE_INSUFFICIENT
SOURCE_UNHEALTHY
```

并携带：

```text
coverage evidence
source health
watermark
last reliable observation
gap intervals
assessment policy version
```

首版可以基于现有 Sensor Coverage、Watermark、Gap 和配置策略，不要求完整传感器仿真。
