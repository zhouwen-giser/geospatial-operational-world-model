# 17 — 数据库迁移与只读合同

实际 migration 编号以执行时最新仓库为准。建议逻辑顺序：

```text
reference identity kind extension
reference names/identifiers/descriptors
dataset/layer/feature catalog
reference search projection
query result/derived reference/reference set
operational task events/current projection
correlation claims/findings
predicate evaluations/observability assessments
read contracts and service roles
```

## 只读合同

```text
gowm_reference_v1
gowm_catalog_v1
gowm_world_evidence_v1
gowm_operational_reality_v1
```

Provider 只读这些合同；无 Base Table 权限。

## 迁移验收

- 001–014 Hash 不变；
- fresh install；
- 从 v0.1 升级；
- 从 v0.2 升级；
- 重复执行；
- 回滚故障事务；
- 数据和 ReferenceKey 保留；
- Scope 和角色权限实际验证。
