# 11 — 事件接入与关联传播

## 公共关联字段

```text
executionIntentId
operationCorrelationId
externalPlanningTaskId
externalPlanningStepId
providerActionId
deviceCommandId
```

这些字段从 SDAR→SMPP→Provider→Observation/Event 传播，但在 GOWM 中只形成：

```text
ExternalCorrelationClaim
```

不成为 OperationalTask 主键或状态权威。

## 事件类型

```text
CONTROL_REQUEST_OBSERVED
CONTROL_ACCEPTED_OBSERVED
CONTROL_REJECTED_OBSERVED
EXECUTION_STARTED_OBSERVED
EXECUTION_PROGRESS_OBSERVED
EXECUTION_PAUSED_OBSERVED
EXECUTION_STOPPED_OBSERVED
CONTROL_COMPLETED_REPORTED
PHYSICAL_EFFECT_PARTIALLY_CONFIRMED
PHYSICAL_EFFECT_CONFIRMED
PHYSICAL_EFFECT_CONTRADICTED
EXECUTION_FAILED_OBSERVED
EXECUTION_CANCELLED_OBSERVED
OBSERVATION_GAP_OPENED
OBSERVATION_GAP_CLOSED
```

## Ingest

- 事件必须有稳定 ID；
- 重试不得换 ID；
- `eventTime` 与 `receivedTime` 分离；
- Future/late/out-of-order 受版本化策略处理；
- 原始 Observation/Event 不可变；
- Projection 失败不得部分更新 Current Snapshot。
