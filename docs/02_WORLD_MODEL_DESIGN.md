# 02 — World Model Design

> Historical v1.1 baseline. GOWM+ v1.2 evidence and MobilityDB changes are defined in documents 13–16.

## 设计目标与不变量

World Model 是运行世界状态的唯一权威读模型。Agent 可有 working memory、task context 和短期 cache，但这些数据必须携带 `worldVersion`/TTL，不能反向宣称权威。

必须始终成立：

1. Observation immutable；它不会直接 `UPDATE world_object_state`。
2. 只有 Projection Worker 或显式受权的 manual state command 能产生新 World State version。
3. Current State 只有当前快照；历史 Observation/Event/Trajectory 分离。
4. 有空间含义的对象使用 PostGIS geometry，不把坐标藏在任意 JSON。
5. 每个 observation-derived state 都可追溯到 `sourceObservationId`。
6. `worldVersion` 单调递增；响应同时返回 data freshness，而不是将“最新版本”等同于“新鲜数据”。

## 聚合 API 模型

```json
{
  "id": "vehicle-001",
  "type": "Vehicle",
  "subtype": "UGV",
  "geometry": { "type": "Point", "coordinates": [116.4, 39.9] },
  "h3": { "r7": "...", "r8": "...", "r9": "...", "r10": "..." },
  "state": { "status": "AVAILABLE", "speed": 3.2 },
  "properties": { "fleet": "north" },
  "relations": [],
  "confidence": 0.98,
  "observedAt": "2026-08-11T01:02:03.000Z",
  "updatedAt": "2026-08-11T01:02:03.014Z",
  "version": 128,
  "provenance": {
    "source": "uav",
    "sourceObservationId": "obs-987",
    "observedAt": "2026-08-11T01:02:03.000Z",
    "receivedAt": "2026-08-11T01:02:03.010Z",
    "confidence": 0.98
  },
  "freshnessMs": 831,
  "stale": false
}
```

GeoJSON 坐标严格为 `[longitude, latitude, altitude?]`，SRID 为 4326。Altitude 保留在 API/trajectory 数值列；PoC 空间 topology 使用 `ST_Force2D`。

## 持久模型拆分

| 表 | 责任 | 更新模式 | Source of truth |
|---|---|---|---|
| `world_object` | 身份、type/subtype、相对静态 properties、soft delete | 低频 | Object registry |
| `world_object_state` | 单行当前动态状态、置信度、时间、来源、version | 投影 upsert | Current state |
| `world_object_geometry` | 单行当前 geometry + h3-pg `h3index` R7–R10 | 投影 upsert | Current geometry |
| `world_relation` | 显式、稳定的 typed relation 和有效期 | 低频 append/close | Persisted relation |
| `world_observation` | 不可变外部陈述、处理状态 | append | Historical evidence |
| `world_event` | 系统确认事件/outbox、worldVersion/causation | append | Event history |
| `trajectory_point` | 每个有效 position observation | append | Historical track |
| `situation_cell` | 可重建的 H3 projection | increment/decrement | Derived situation |

拆表不是微服务边界。MVP 中它们同属一个 PostgreSQL schema 和一个事务边界，避免分布式双写。

## 第一批 Object Types

Registry 接受扩展 type，但以下是 1.0 canonical vocabulary：

| 类别 | Types | 典型 state |
|---|---|---|
| Actor | `Agent` | role, status, capabilities |
| Device | `Device`, `Sensor`, `Camera` | online, health, mode |
| Mobile | `Vehicle`, `UGV`, `UAV` | status, position, heading, speed, battery |
| Infrastructure | `Facility`, `Road`, `RoadSegment` | operational status, access |
| Area | `Zone`, `AOI`, `Geofence` | status, rule/profile |
| Work | `Mission`, `Task` | lifecycle, priority |
| Situation | `Incident`, `Alert`, `Situation` | severity, status |
| Path | `Route` | route metadata; geometry is LineString |

`Observation` 保留在 canonical type vocabulary 中以支持外部引用/互操作，但默认不实例化为 `world_object`；它使用独立 envelope/table。这样既满足类型兼容，又不会让每个高频 Observation 成为可查询 Twin、污染 current object cardinality。

扩展 type 规则：非空 PascalCase；必须登记 owner、JSON schema、允许 geometry 类型、freshness SLA 与 source priority。未知 type 可进入隔离 tenant/namespace，但在 governance 审批前不能参与安全关键自动执行。

## State 与 Properties

- `properties`：相对静态描述，如型号、fleet、capacity；手工/资产系统更新。
- `state`：随运行变化的事实，如 `status/battery/speed/position`；主要由 Observation projection 更新。
- `position` 在 API `state` 中提供 Agent-friendly 便利，同时 `world_object_geometry` 才是空间查询权威。
- JSONB 允许快速扩展，但 P0 字段须由 Zod/JSON Schema 控制；不能把所有字段都定义成无约束 blob。

同一 field 的 ownership 在 Stage 1 加 `state_field_policy`：允许 source、freshness SLA、merge strategy、是否 safety critical。PoC 的 projection 是对象级策略，未来扩展点是 field-level projector，而不是改动 Observation 格式。

## Relation Model

### 持久关系

| Relation | 是否持久 | 原因 |
|---|---:|---|
| `connectedTo` | 是 | 网络/道路/设施拓扑是业务声明 |
| `assignedTo` | 是 | 任务分配有生命周期和审计需求 |
| `executing` | 是 | 当前执行关系由 command/operations 明确产生 |
| `observedBy` / `observes` | 是（配置语义） | 摄像头/传感器责任范围或长期绑定 |
| `affects` | 是 | Incident→asset/area 的确认关系 |
| `coveredBy` | 是（规划结果） | 外部 Coverage Planner 产出的版本化关系 |
| `belongsTo` | 是 | fleet/organization/mission 归属 |

### 计算关系

| Relation | 计算方式 | 是否缓存 |
|---|---|---|
| `locatedIn` | `ST_Covers(area, object.geometry)` | 仅为 geofence event 缓存 membership |
| `contains` | `locatedIn` 反向 | 不持久 |
| `near` | `ST_DWithin` + distance threshold | query-time；高频规则可物化 subscription |
| `locatedOn` | 点到 RoadSegment 距离/投影，需 domain tolerance | query-time；确定 snap policy 后再缓存 |

`persisted=false` 的 relation 不能通过普通 create API 写入；生产版应强制此约束。PoC 暴露 `persisted` 以便验证模型，调用方仍应遵守表中规则。

## 版本、一致性与并发

- PostgreSQL sequence 生成全局单调 `worldVersion`；不是无缺口业务序号，事务 rollback 可跳号。
- 对象 update 可带 `expectedVersion`，不匹配返回 HTTP 409，支持 Agent optimistic concurrency。
- Projection 事务 `FOR UPDATE` 锁 subject identity，防止同一对象并发写入次序不确定。
- Projection queue 用 `FOR UPDATE SKIP LOCKED` claim；失败指数退避；`projected_at` 保证重投幂等。
- API read 是 PostgreSQL committed view。MVP 不提供跨多请求快照；需要时用 `sinceWorldVersion` 事件补齐。

## 四种时间

| 时间 | 定义 | 使用 |
|---|---|---|
| Observation Time (`observedAt`) | 传感器认为事实发生的时间 | fusion、trajectory 排序、freshness |
| Event Time (`event.timestamp`) | 系统事件所表达事实的时间 | subscription/replay；move 用 observedAt，received 用 receivedAt |
| Processing Time | ingest 在服务处理/持久化时间 | latency、监控、排障 |
| World State Time | 当前胜出证据的 observedAt + state updatedAt | Agent 判断状态年龄/投影延迟 |

不允许用 Processing Time 覆盖 Observation Time。设备时钟异常须拒绝或隔离；不能因“最后到达”就认定“最新事实”。

## Freshness 与 Provenance

PoC 默认 `STALE_AFTER_MS=30000`：

```text
freshnessMs = max(0, now - lastObservedAt)
stale = lastObservedAt missing OR freshnessMs > type/field SLA
```

Stage 1 应按 type/field 配 SLA，例如 UGV position 5s、Facility operational status 5min。每个响应都保留：`confidence/source/sourceObservationId/observedAt/receivedAt`。P1 `evidence[]` 可列出未胜出的观测，但不改变当前字段的主 provenance。

## Ontology 决策门

Typed Object + Relation 能直接支持当前 10 个场景。只有同时出现以下条件才启动 ontology/KG spike：

1. 至少三个独立 domain 需要 type inheritance/constraint reasoning；
2. 关系 traversal 无法被预定义 API 覆盖；
3. 语义对齐成本已超过 registry governance 成本；
4. 有明确的 Agent KPI 和 benchmark，不以“未来可能”为理由。

即使采用 KG，实时位置和 topology 查询仍留在 PostGIS；KG 只能是语义/关系投影，不应成为第二个 current position source。
