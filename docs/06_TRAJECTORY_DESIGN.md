# 06 — Trajectory Design

> Historical v1.1 baseline. `trajectory_point` is now a compatibility view; MobilityDB TrackletVersion is normative in v1.2.

## 决策

Current Position 与 Historical Track 必须分开：

```text
world_object_state + world_object_geometry
  └─ one current position / object

trajectory_point
  ├─ P1 @ event time
  ├─ P2 @ event time
  └─ ... append-only
```

这样 `get_current_position` 不随历史增长，Twin/Object 也不会无限膨胀。MVP 全部使用 PostgreSQL/PostGIS；不默认启用 TimescaleDB 或 ClickHouse。

## 数据模型

| Column | Type | 说明 |
|---|---|---|
| `entity_id` | text | object id |
| `observed_at` | timestamptz | event/observation time |
| `observation_id` | text unique | 幂等与 provenance |
| `geometry` | `geometry(Point,4326)` | 空间事实 |
| `latitude/longitude/altitude` | double | Agent/分析便利；2D topology 与 altitude 分离 |
| `heading/speed` | double | source measurement |
| `state` | jsonb | point-associated state snapshot |
| `source/confidence` | text/real | provenance |
| `h3_r7...r10` | `h3index` | h3-pg 原生区域/time analysis |

主键 `(entity_id, observed_at, observation_id)`；额外 unique `observation_id` 防重复。索引：`entity_id,observed_at DESC`、BRIN(observed_at)、GiST geometry/geography、`h3_r9,observed_at`。

## 写入语义

- 每个通过 ingest 且含 Point geometry 的 Observation 由 projector `ON CONFLICT(observation_id) DO NOTHING` 追加轨迹。
- 即使 Observation 未胜出 current-state fusion，只要进入 projector，历史证据仍可记录；这允许分析多源路径。查询可按 source/confidence 扩展过滤。
- 迟到且被 ingest 隔离的 Observation 当前不进 track；这是 PoC 明确限制。
- Current State 只由胜出 Observation 更新，并携带同一 observation id。

## API

| Tool | REST | PoC 状态 |
|---|---|---|
| `get_current_position` | `GET /trajectory/:id/current` | 已实现，按 event time 最新轨迹点 |
| `get_last_known_position` | 同上；Agent 结合 freshness | 已实现语义 |
| `get_track` | `GET /trajectory/:id/track?from&to&limit` | 已实现 |
| `get_track_between` | 同上带 from/to | 已实现 |
| `get_recent_track` | `GET /trajectory/:id/recent?durationMs` | 已实现 |
| `get_distance_traveled` | track response summary | 已实现 Haversine sum |
| `detect_stop` | `GET /trajectory/:id/stops` | 已实现 |
| `detect_dwell` | stops + area semantics | P1，domain threshold 待定 |
| `detect_route_deviation` | `POST /trajectory/:id/route-deviation` | 已实现 point-to-line tolerance |

注意：`trajectory/current` 是最新历史点；权威 current state 应优先使用 `GET /world/objects/:id`，因为迟到/冲突证据可能存在轨迹但不胜出 current state。Agent Tool `trajectory.get_current_position` 应在 response 中标注 `authoritativeCurrent` 或同时返回 World State provenance（Stage 1 修订）。

## Stop / Dwell / Deviation

- Stop：连续点保持在 `radiusM` 内且持续超过 `minimumDurationMs`。
- Dwell：Stop 与目标 Polygon `ST_Covers` 结合，并允许 entry/exit grace period；PoC 尚未将 area join 包装成独立 endpoint。
- Route deviation：每个点到 LineString 的最短距离超过 `toleranceM`；返回偏离点/最大距离。PoC 使用本地几何近似，生产版应在 PostGIS geography 上计算并定义 route segment 顺序。

这些检测均须返回 input time window、point count、threshold、confidence，避免 Agent 将低采样率“无移动”误判为停车。

## Storage Options

| 选项 | MVP 交付 | 时序写/retention | 空间能力 | 运维 | 决策 |
|---|---:|---:|---:|---:|---|
| A PostgreSQL + PostGIS | 5 | 3 | 5 | 5 | **采用** |
| B + TimescaleDB | 4 | 5 | 5 | 4 | 达 trigger 后首选扩展 |
| C PostGIS + ClickHouse | 2 | 5 | 3–4 | 2 | 亿/十亿级 OLAP 后采用派生库 |
| D Ditto + PostGIS + time store | 1 | 4 | 4 | 1 | 不采用 |

## Capacity estimate

C7 的 100 vehicles × 1 point/s = 8.64M points/day。粗估每行含 tuple/index/JSON 后 250–500 bytes，即约 2.2–4.3 GiB/day，实际须用 `pg_total_relation_size` 测量。30 天原始 retention 可达 65–130 GiB，足以要求 Day-1 明确 retention，而不是无限保存。

建议：

- Stage 0：100 vehicles、短 retention，原生表。
- Stage 1：按月/周 declarative partition，raw 30 天；降采样 track 180 天；法规要求另定。
- >100M retained points 或目标 track p95 >200ms（索引/partition/vacuum 调优后）时评估 Timescale 2.x。
- >1B retained points，或 sustained >20k points/s 且长周期 OLAP p95 仍不达标时，把 append data 异步投影到 ClickHouse；PostGIS 保持 current spatial source。

100M/1B/20k/s 是明确工程容量门槛；当前无 Docker 环境未实测 DB 写入，不能作为已证明极限。真实阈值由 `output/benchmarks/postgis-benchmark.json`、storage growth 和目标 SLO 校准。

## Retention 与 replay

Observation 是重建依据，trajectory 是可重建派生事实。若对 Observation 先删除而保留 track，就失去完整 provenance；retention policy 必须成对设计：

1. immutable raw observation tier；
2. hot full-resolution trajectory；
3. cold/downsampled trajectory；
4. current state 永久保留至对象删除/归档；
5. deletion/audit 按 tenant/legal policy 执行。

Replay 写轨迹使用 observation unique key，可 at-least-once 重放而不重复点。
