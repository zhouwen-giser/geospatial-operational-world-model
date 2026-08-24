# 10 — v0.4 Operational Reality 模型

## 事件源

```text
OperationalTaskEvent (immutable)
        ↓
OperationalTaskSnapshot (rebuildable)
```

禁止直接写 Current Snapshot。

## 四维状态

```text
controlState
activityState
outcomeVerification
observability
```

### Control State

```text
NO_CONTROL_EVENT
REQUESTED_OBSERVED
ACCEPTED_OBSERVED
REJECTED_OBSERVED
COMPLETED_REPORTED
FAILED_REPORTED
CANCELLED_REPORTED
```

### Activity State

```text
NOT_OBSERVED
STARTED_OBSERVED
ACTIVE_OBSERVED
PAUSED_OBSERVED
STOPPED_OBSERVED
UNKNOWN
```

### Outcome Verification

```text
NOT_APPLICABLE
UNVERIFIED
PARTIALLY_VERIFIED
VERIFIED
CONTRADICTED
INDETERMINATE
```

### Observability

```text
FRESH
STALE
OBSERVATION_GAP
NO_DATA
```

四个维度独立投影，不允许压缩为一个 COMPLETED。
