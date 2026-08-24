# 04 — v0.3 Reference Identity 与 Catalog

## 现有基础

v0.2 已有不可变 `world_reference_identity`。v0.3 不替换它，而是扩展可引用实体种类，
并增加独立的追加式描述和名称模型。

## 目标实体种类

```text
WORLD_OBJECT
SPATIAL_OBJECT
DATA_SCOPE
DATASET
LAYER
LAYER_FEATURE
QUERY_RESULT
DERIVED_REFERENCE
REFERENCE_SET
OPERATIONAL_TASK
```

新增种类通过新 migration 修改约束；不改既有 migration。

## Name/Alias

```text
world_reference_name
world_reference_external_identifier
world_reference_descriptor_version
reference_search_projection
```

名称种类：

```text
CANONICAL_NAME
ALIAS
DISPLAY_LABEL
CODE
EXTERNAL_ID
PINYIN
ABBREVIATION
OPERATOR_LABEL
```

每条名称必须包含：

```text
reference_key
data_scope_key
language_tag
normalized_text
source/evidence
confidence
valid_time
created_at
```

## 解析优先级

```text
Exact ReferenceKey
Exact External ID / Code
Exact Canonical Name
Exact Alias
Normalized/Pinyin
Fuzzy Name
Spatial Context Ranking
```

首版不引入向量数据库。Fuzzy 采用受限 pg_trgm，必须有候选数和相似度阈值。

## 安全

- 所有候选先 Scope 过滤；
- 不返回其他 Scope 的存在性；
- `referenceKey` 不透明；
- 匹配分数不代表当前状态可信度。
