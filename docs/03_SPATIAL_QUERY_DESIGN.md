# 03 — Spatial Query Design

## 决策

PostGIS 是 MVP Spatial Engine。Geometry 是权威空间事实；H3 是加速态势理解的派生维度；两者不互相替代。

PoC 使用 EPSG:4326：

- 拓扑关系和 KNN 初筛使用 `geometry` + GiST。
- 米制距离/半径使用 `geography` cast + expression GiST index。
- GeoJSON 输入统一 `[lon,lat]`，拒绝越界坐标、自交 polygon、空 ring 和不闭合 polygon。
- Point/LineString/Polygon/MultiPolygon 是 P0；3D topology 不在范围。

## API 与价值

| Tool 语义 | REST | P | PostGIS 核心 | 返回摘要 |
|---|---|---:|---|---|
| `get_object` | `GET /world/objects/:id` | P0 | keyed join | freshness/confidence/provenance |
| `find_objects` | `POST /world/objects/search` | P0 | JSONB/type indexes | count/byType |
| `find_objects_near` | `POST /spatial/nearby` | P0 | `ST_DWithin` + `ST_Distance` | count/nearestDistanceM/radiusM |
| `find_nearest_objects` | `POST /spatial/nearest` | P0 | GiST KNN `<->` | count/nearestDistanceM |
| `find_objects_in_area` | `POST /spatial/in-area` | P0 | `ST_Covers` | count/byType |
| `get_containing_areas` | `POST /spatial/containing-areas` | P0 | reverse `ST_Covers` | containing area count |
| `calculate_distance` | `POST /spatial/distance` | P0 | geography `ST_Distance` | distanceM |
| `get_intersections` | `POST /spatial/intersections` | P1 | `ST_Intersects` | count |
| `objects_near_route` | `POST /spatial/near-route` | P1 | geography `ST_DWithin` LineString | count/nearestDistanceM |
| `objects_along_route` | `POST /spatial/objects-along-route` | P1 | same corridor primitive | ordered candidates |
| `get_area_summary` | `POST /spatial/area-summary` | P0 | cover + group by type | total/byType |

## Nearby Asset 合约

```json
POST /spatial/nearby
{
  "location": { "lat": 39.9, "lon": 116.4 },
  "objectTypes": ["UGV"],
  "radiusM": 5000,
  "filter": { "status": "AVAILABLE" },
  "limit": 10
}
```

确定性排序为 `distanceM ASC, object.id ASC`。`filter` 是 JSON containment，允许 state 或 properties 命中。生产版必须将允许过滤字段加入 schema/allow-list，防止任意大 JSON 查询造成资源滥用。

```json
{
  "summary": { "count": 3, "nearestDistanceM": 230, "radiusM": 5000 },
  "facts": [
    {
      "object": {
        "id": "ugv-003",
        "type": "UGV",
        "state": { "status": "AVAILABLE" },
        "freshnessMs": 530,
        "confidence": 0.97,
        "provenance": { "sourceObservationId": "obs-1", "source": "uav" }
      },
      "distanceM": 230
    }
  ],
  "context": { "worldVersion": 10283, "dataFreshnessMs": 530, "queryTimeMs": 8 }
}
```

Agent 可直接比较可用性、距离、数据年龄和可信来源；无需自行 join 或把旧位置当新位置。

## 精确空间语义

| 需求 | 选择 | 边界行为 |
|---|---|---|
| point 在 area 内 | `ST_Covers(area, point)` | boundary 算 inside，适合 geofence |
| geometry 相交 | `ST_Intersects(a,b)` | 任意公共点即 true |
| 距离/半径 | geography | 球面米制；MVP 精度足够 |
| nearest | geometry KNN 初排 + geography distance 返回 | 极大范围/极区需二阶段精排 |
| route corridor | geography `ST_DWithin(object, line, bufferM)` | 不做 routing/network reachability |
| area 面积排序 | geography area | containing areas 从最小到最大 |

`find_objects_in_area` 对非 Point 对象的语义是“查询 area 完全 covers 该 geometry”；`get_intersections` 用于部分重叠。API 必须区分两者，避免 Agent 把 intersection 当 containment。

## Geometry / H3 / Relation 的统一

```text
world_object.id
  ├─ current geometry (PostGIS; authoritative)
  ├─ H3 R7/R8/R9/R10 (`h3index`; derived, rebuildable)
  ├─ stable relation (persisted)
  └─ locatedIn/near/contains (computed from geometry)
```

空间结果必须回传计算时的 `worldVersion`。H3 candidate search 只能做粗筛；涉及安全边界/精确距离时必须回到 PostGIS 验证。

## Index 与查询计划

Migrations 提供：

- `world_object_geometry USING gist(geometry)`：topology/KNN。
- `USING gist((geometry::geography))`：meter-distance expression index。
- h3-pg R7–R10 `h3index` B-tree：exact cell/time filter；parent filter 用稳定 hierarchy function。
- state/properties GIN：JSON containment。
- Observation/Trajectory geometry GiST 和 time BRIN。

目标环境 benchmark 必须保存 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`（下一迭代项），确认 `ST_DWithin` 没退化为全表扫描。超过 500ms 的 polygon query 要先做 `ST_Subdivide`/simplified AOI、限制顶点数量，再考虑新数据库。

## Guardrails

- radius 最大 1,000 km、limit 最大 1,000；track 最大 100k points。
- Polygon 请求限制 body 10 MiB；生产版再加顶点数、面积和复杂度上限。
- 只接受有效 GeoJSON 和经度/纬度范围。
- response 不返回任意 SQL/内部列名。
- 对 safety-critical action，`stale=true` 或 confidence 低于 policy 阈值时由 Agent/Operations 拒绝执行。
- 跨 tenant/RBAC 必须在 SQL predicate 层实现，不能仅在 API 返回后过滤。

## PostGIS 不足的触发条件

PostGIS 不是永久承诺，但迁移必须由证据驱动：

1. 目标硬件上 1M current objects 的 P0 query p95 超过 100ms，且 index/query tuning 后仍失败；
2. 单 trajectory 表超过 100M retained points 后，目标时间窗 track p95 超过 200ms；
3. OLTP 与历史分析互相争抢 I/O，resource group/replica/partition 无法隔离；
4. 需要超过单区域 PostgreSQL 的写入/HA 目标。

触发 1 优先分区/读副本/几何优化；触发 2 优先 TimescaleDB；触发 3 且分析规模 >1B points 再引入 ClickHouse 派生存储。
