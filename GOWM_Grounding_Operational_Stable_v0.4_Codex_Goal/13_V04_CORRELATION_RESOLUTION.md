# 13 — Correlation Resolution

## 输入

```text
ExternalCorrelationHint
Resource/Actor Reference
Time Window
Spatial Context
Provider Action/Command
```

## 关系

```text
REPORTS_EXECUTION_OF
REALIZES
PARTIALLY_REALIZES
POSSIBLY_CORRESPONDS_TO
NO_MATCH_FOUND
CONFLICTING_MATCHES
```

## Match Basis

```text
PROPAGATED_CORRELATION_ID
PROVIDER_DECLARED
MANUAL_CONFIRMATION
RESOURCE_AND_TIME_MATCH
SPATIOTEMPORAL_INFERENCE
```

可靠性顺序必须显式；推导匹配不能覆盖明确 ID 冲突。

## 结果

CorrelationFinding 是追加式分析结果：

```text
candidate operational task/events
basis
confidence
supporting/contradicting evidence
worldVersion
methodVersion
```

不得修改 SDAR 或 OperationalTask 身份。
