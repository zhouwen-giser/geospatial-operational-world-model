# 04 — H3 Situation Design

## 角色

H3 是 GOWM 的统一、多分辨率 **Situation Index**。它回答“哪里值得看”和“区域大致发生什么”，而 PostGIS 回答精确对象/边界问题。

```text
World Geometry / Observation
           ↓ deterministic projection
      H3 R7 / R8 / R9 / R10
           ↓ count + recency
       Situation Cell
           ↓ rank / drill-down
          Agent
```

任何 H3 数据都可从 current geometry + observations 重建，所以不是第二 Source of Truth。PoC 数据库镜像固定 h3-pg `4.5.0`，启用 `h3` 与 `h3_postgis` 扩展；对象、轨迹和 situation cell 的索引均以原生 `h3index` 存储。

## 分辨率策略

| Resolution | PoC 用途 | 查询模式 |
|---:|---|---|
| R7 | 城市/大区域态势入口 | top-10 hotspot、任务区粗筛 |
| R8 | 区域中层聚合 | R7 child ranking |
| R9 | 局部操作态势默认层 | AOI、coverage/activity map |
| R10 | 近场细看 | sensor/vehicle 密集区 drill-down |

具体物理面积随纬度而变化，不能把 resolution 当固定米制网格。Agent 不应硬编码面积；需要时 API 返回 boundary/area metadata。

Point 由 h3-pg `h3_latlng_to_cell` 同时计算 R7–R10。Polygon area cell 由 `h3_polygon_to_cells` 生成，其 center containment 语义不能替代精确边界；对边界敏感的 geofence 事件仍使用 `ST_Covers`。

## Situation Cell

```json
{
  "h3Index": "8931...",
  "resolution": 9,
  "metrics": {
    "agentCount": 2,
    "vehicleCount": 14,
    "sensorCount": 8,
    "incidentCount": 1,
    "observationCount": 940,
    "riskScore": 38.8,
    "coverageScore": 80,
    "activityScore": 82.2,
    "freshnessScore": 96.1
  },
  "updatedAt": "...",
  "worldVersion": 10283,
  "boundary": { "type": "Polygon", "coordinates": [] }
}
```

## 预计算 vs Query-time

### 预计算基础量

- `agent_count`
- `vehicle_count`
- `sensor_count`
- `incident_count`
- `observation_count`
- `unique_observer_count`
- `last_observed_at`
- `world_version`

对象首次进入或跨 cell 时维护 object counts；Observation 进入时增加 observation count 和 per-observer activity。计数跨 R7–R10 同时写，换取稳定低延迟 drill-down。该写放大固定为最多 4 层，在 MVP 可控。

### PoC query-time score

数据库 view 当前使用透明、可解释公式：

```text
risk      = clamp(incident_count × 20 + observation_count × 0.02, 0, 100)
coverage  = clamp(unique_observer_count × 20, 0, 100)
activity  = clamp(ln(1 + observation_count) × 12, 0, 100)
freshness = max(0, 100 - seconds_since_last_observation / 3)
```

这些是 PoC 验证公式，不是业务风险真相。上线前由 domain owner 定义版本化 metric profile，例如 `risk/v2`。所有阈值/权重必须可审计，不允许在 Agent prompt 中暗藏。

### 应保持 query-time 的量

- 指定任务/对象类型/时间窗的 activity；
- safety/mission 专属 risk 权重；
- 多 cell AOI 去重后的对象数；
- coverage SLA、夜间/天气等上下文；
- Road/Facility exposure 等精确几何关系；
- “未观察 cell”所需目标 cell set 与 freshness threshold。

当同一 query-time 指标稳定被大量复用、计算成本可测且有清晰 invalidation 时，才物化。

## API

| 能力 | Endpoint | 说明 |
|---|---|---|
| `get_cell` | `GET /situation/cells/:index` | 单 cell |
| `get_cells` | `POST /situation/cells` | batch indexes |
| `get_area_cells` | `POST /situation/area` | polygon→cells，空 cell 也返回 |
| `get_neighbor_cells` | `GET /situation/cells/:index/neighbors?ring=1` | gridDisk |
| parent/children | `GET /situation/cells/:index/hierarchy?resolution=R` | roll-up/drill-down |
| `get_hotspots` | `POST /situation/hotspots` | ranked metric desc |
| `get_coldspots` | `POST /situation/coldspots` | asc |
| maps | `/activity-map`, `/coverage-map`, `/risk-map` | 固定 metric |
| `find_unobserved_cells` | `POST /situation/coverage-gaps` | coverage asc；P1 增加 freshness window |

## Drill-down 流程

```json
POST /situation/hotspots
{ "resolution": 7, "metric": "activity", "limit": 10 }
```

选中 R7 cell 后：

```json
POST /situation/hotspots
{ "resolution": 9, "metric": "activity", "parentCell": "<R7>", "limit": 10 }
```

PoC 直接用 h3-pg `h3_cell_to_parent(h3_index, parent_resolution)` 在数据库过滤 child，避免把所有 candidate 拉到 Node.js。若同一 parent filter 的 p95 在调优后仍超过 50 ms，再物化 R7/R8/R9 parent 列并建立 B-tree；不启用 4.5.0 中仍标为 experimental 的 GiST operator class。

## Roll-up 一致性

每层计数直接从事件更新，而非仅从 R10 向上求和，因而查询快但需 replay 校验。以下不变量由周期 reconciliation 检查：

- count 不得为负；
- 对同一对象，每 resolution 最多存在一个 membership；
- R7 count 应与其 current object projection 汇总一致；
- `worldVersion` 不回退；
- observation replay 后指定窗口的 count/checksum 一致。

PoC replay 只校验核心 World State；Situation 全量 deterministic rebuild 是 Stage 1 验收扩展项。这一限制在验收报告中标明。

## 与现有 H3 Toolkit / Coverage Planner 集成

- H3 Toolkit：通过 batch `get_cells/get_area_cells` 接收 canonical H3 strings；不复制 toolkit 算法。
- Coverage Planner：读取 `coverage-map/coverage-gaps`，把规划结果作为带 `modelVersion/worldVersion` 的 `coveredBy` relation 或 `CoverageChanged` event 回写。
- GOWM 不运行 coverage solver；它只提供事实输入、版本化结果注册和事件通知。

## 性能与存储

当前进程内真实 H3 全量聚合：1k 10.08ms、10k 15.12ms、100k 106.77ms、1M 1041.12ms，约 961k objects/s（1M run）。这是 `h3-js` full-rebuild 算法基线；在线查询读 h3-pg 原生类型的预聚合 cell，不会遍历 1M objects。数据库内 h3-pg 的 projection/parent/area 性能必须在 Docker host 由 acceptance benchmark 补测；若 online H3 update 成为瓶颈，先 batch/upsert、减少 resolution 或异步 micro-batch，再评估流处理器。
