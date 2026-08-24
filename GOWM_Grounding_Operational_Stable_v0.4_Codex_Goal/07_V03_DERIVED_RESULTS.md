# 07 — DerivedReference、ReferenceSet 与 Result Registry

## Query Result Registry

Gateway 已有 Query/Node/Result 运行记录。v0.3 增加稳定公共结果引用：

```text
world_query_result_reference
world_query_artifact
derived_reference
reference_set
reference_set_member
```

## DerivedReference

必须记录：

```text
sourceQueryId/nodeId
operator
input reference keys
data snapshot hash
compute snapshot hash
method version
geometry/artifact ref
validUntil
revalidationRequired
```

派生引用不自动成为 WorldObject。

## ReferenceSet

- 创建时成员不可变；
- 大集合 Cursor 分页；
- memberCount 与 truncation；
- 集合自身有 ReferenceKey；
- TTL 到期后保留审计记录但拒绝直接用于操作；
- 可通过新查询重新生成。

## 结果验证

```text
result.get
result.validate
reference-set.get-members
```

验证结果：

```text
VALID
STALE
EXPIRED
SNAPSHOT_UNAVAILABLE
REFERENCE_RETIRED
SCOPE_DENIED
```
