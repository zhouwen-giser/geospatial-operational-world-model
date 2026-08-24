# 16 — v0.4 Gateway Provider 集成

新增 Provider：

```text
gowm.operational-reality
```

注册：

```text
operational-task.find
operational-task.get
operational-task.get-timeline
operational-task.find-by-correlation

world-event.find-by-correlation
world-event.get-timeline

correlation.resolve
predicate.evaluate
observability.evaluate
```

另稳定：

```text
gowm.reference-catalog
gowm.dataset-catalog
gowm.world-evidence
```

所有 Operation 具有：

```text
operation version
schema hash
scope policy
snapshot policy
cost class
limits
maturity
```

Gateway 不理解四维投影算法，只负责路由和编排。
