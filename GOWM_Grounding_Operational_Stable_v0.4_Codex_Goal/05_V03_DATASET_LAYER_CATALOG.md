# 05 — v0.3 Dataset、Layer、Feature Catalog

## 开放目录模型

```text
spatial_dataset
spatial_dataset_version
spatial_layer
spatial_layer_version
spatial_feature_identity
spatial_feature_version
```

Dataset Kind：

```text
VECTOR
RASTER
ELEVATION
NETWORK
POINT_CLOUD
TILESET
CURRENT_PROJECTION
```

v0.3 只要求 VECTOR 和 CURRENT_PROJECTION 真实实现，其他 Kind 只冻结合同。

## Version

每个版本记录：

```text
data_scope
source/source_version
schema_version
CRS
valid_time
quality
lineage
content hash
published/retired time
```

## 与现有 spatial_object 的关系

- 不复制既有 SpatialObject 事实；
- 可通过 binding 将 SpatialObject/Version 注册为 Layer Feature；
- Layer/Feature ReferenceKey 独立于内部 UUID；
- 版本化 Feature 不覆盖历史几何。

## 能力

```text
dataset.get
dataset.list
layer.get
layer.list
layer.find-features
feature.get
```
