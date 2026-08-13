# 07 — Agent Tool Design

## 目标

Agent 只表达意图和约束，不接触 SQL、SRID、GiST、H3 parent 规则或 trajectory table。每个 Tool 返回可推理摘要、结构化事实、world version、freshness、confidence 与 provenance；不能只返回数据库行。

## Tool Catalog

| # | Agent Tool | P | 输入重点 | Agent-friendly 输出 | PoC MCP |
|---:|---|---:|---|---|---:|
| 1 | `world.get_object` | P0 | objectId | current object + freshness/provenance | `get_world_state` |
| 2 | `world.find_objects` | P0 | types/filter/text/limit | count/byType + objects | REST |
| 3 | `world.get_state` | P0 | objectId/fields | selected current facts | via get_world_state |
| 4 | `world.get_freshness` | P0 | objectId/field | freshnessMs/stale/SLA | via get_world_state |
| 5 | `world.get_provenance` | P0 | objectId/field | source/observation/confidence/time | via get_world_state |
| 6 | `spatial.find_nearby` | P0 | point/types/radius/filter | ordered distances + nearest summary | `find_nearby_objects` |
| 7 | `spatial.find_nearest` | P0 | point/types/filter/k | nearest facts | REST |
| 8 | `spatial.find_in_area` | P0 | polygon/types/filter | count/byType + objects | `find_objects_in_area` |
| 9 | `spatial.get_containing_area` | P0 | point | smallest→largest areas | REST |
| 10 | `spatial.distance` | P0 | two points/objects | distanceM + method | REST |
| 11 | `spatial.get_intersections` | P1 | geometry/types | intersecting objects | REST |
| 12 | `spatial.objects_along_route` | P1 | route/buffer/types | route corridor candidates | REST |
| 13 | `spatial.get_area_summary` | P0 | polygon | total/byType | REST |
| 14 | `situation.get_cell` | P0 | H3 index | metrics/version/boundary | `get_h3_situation` |
| 15 | `situation.get_area` | P0 | polygon/resolution | objects + cell totals | `get_area_situation` |
| 16 | `situation.get_hotspots` | P0 | R/metric/parent/k | ranked cells | `get_h3_hotspots` |
| 17 | `situation.get_neighbors` | P1 | H3/ring | cells incl. empty | REST |
| 18 | `situation.get_coverage_gap` | P1 | area/R/freshness SLA | unobserved/stale cells | REST baseline |
| 19 | `observation.publish` | P0 | Observation 1.0 | accepted/duplicate/queued | `publish_observation` |
| 20 | `observation.query` | P0 | subject/observer/type/window | immutable evidence | REST |
| 21 | `event.subscribe` | P0 | type/object/area/version | PostgreSQL replay + MQTT live event stream | SSE/MQTT |
| 22 | `trajectory.get_current_position` | P0 | objectId | latest point + age/source | REST |
| 23 | `trajectory.get_track` | P0 | id/from/to/limit | points + distance summary | `get_object_track` |
| 24 | `trajectory.get_recent_track` | P0 | id/duration | recent ordered points | REST |
| 25 | `trajectory.detect_stop` | P1 | id/window/radius/duration | stop intervals | REST |
| 26 | `trajectory.detect_dwell` | P1 | id/area/window | dwell intervals | design only |
| 27 | `trajectory.detect_route_deviation` | P1 | id/route/tolerance | deviations/max distance | REST |

PoC MCP 实际暴露 8 个聚合工具，覆盖 C8 所需四类读取与 Observation 写入。其余已由 REST/SSE 实现或有 P1 合约；不是声称 27 个都已注册为 MCP。

## Top 10 High-value Services

评分 1–5。`Priority Score = Agent Value × Reuse Potential ÷ Implementation Cost`；Latency Sensitivity 与 Operational Complexity 用于同分取舍，不进入公式。

| Rank | Service / Quick Win | Agent Value | Impl Cost | Latency Sens. | Reuse | Ops Complexity | Score |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | `get_object_current_state` | 5 | 1 | 5 | 5 | 2 | 25.00 |
| 2 | `get_state_freshness` | 5 | 1 | 5 | 5 | 1 | 25.00 |
| 3 | `get_state_provenance` | 5 | 1 | 4 | 5 | 1 | 25.00 |
| 4 | `find_nearby_available_assets` | 5 | 2 | 5 | 5 | 2 | 12.50 |
| 5 | `publish_observation` | 5 | 2 | 5 | 5 | 3 | 12.50 |
| 6 | `get_object_recent_track` | 4 | 2 | 3 | 5 | 2 | 10.00 |
| 7 | `get_area_situation` | 5 | 3 | 4 | 5 | 3 | 8.33 |
| 8 | `subscribe_spatial_event` | 5 | 3 | 5 | 4 | 4 | 6.67 |
| 9 | `get_h3_hotspots` | 4 | 3 | 3 | 4 | 3 | 5.33 |
| 10 | `find_unobserved_cells` | 4 | 3 | 3 | 4 | 3 | 5.33 |

这些服务直接对应 QW1–QW10。前三项成本低却能消除 Agent 各自判断“当前/陈旧/为什么可信”的分歧；应与 nearby 同批投放，而不是当 UI metadata。

## 候选服务评分补充

| Service | Agent Value | Impl Cost | Latency Sens. | Reuse | Ops Complexity | Score | 处置 |
|---|---:|---:|---:|---:|---:|---:|---|
| `find_nearest` | 5 | 2 | 5 | 5 | 2 | 12.50 | P0，同 nearby core |
| `find_in_area` | 5 | 2 | 4 | 5 | 2 | 12.50 | P0 |
| `distance` | 3 | 1 | 4 | 5 | 1 | 15.00 | P0 primitive |
| `observation.query` | 4 | 2 | 2 | 5 | 2 | 10.00 | P0 evidence/debug |
| `trajectory.detect_stop` | 4 | 3 | 2 | 4 | 2 | 5.33 | P1 |
| `trajectory.detect_dwell` | 4 | 4 | 2 | 4 | 3 | 4.00 | P1 after semantics |
| `route_deviation` | 4 | 4 | 4 | 3 | 3 | 3.00 | P1 |
| Full ontology traversal | 2 | 5 | 2 | 2 | 5 | 0.80 | 禁止本阶段 |
| 3D twin visualization | 1 | 5 | 2 | 2 | 5 | 0.40 | 禁止本阶段 |

## 标准响应形状

```json
{
  "summary": {
    "count": 3,
    "nearestDistanceM": 230,
    "answer": "3 available UGVs are within 5 km"
  },
  "facts": [],
  "context": {
    "worldVersion": 10283,
    "dataFreshnessMs": 530,
    "queryTimeMs": 8,
    "confidence": 0.96,
    "provenance": [
      { "source": "uav", "observationId": "obs-9", "observedAt": "..." }
    ]
  },
  "warnings": []
}
```

规则：

- `summary` 可直接用于 Agent 计划下一步，但不得添加 facts 中没有的结论。
- `facts` 使用 stable field names/units；distance 始终 metres、time ISO-8601 UTC。
- `dataFreshnessMs` 对集合取最差/明确统计；不能用 query time 代替。
- `worldVersion` 支持后续 event catch-up；不是全局 wall clock。
- 低 confidence、stale、truncated、partial coverage 必须在 `warnings` 显示。
- 分页/limit 截断时回传 `truncated=true/nextCursor`（Stage 1）。

## MCP 架构

```text
Agent → MCP SDK → world-model-mcp-server → REST APIs → PostGIS/World Model
```

MCP server 是薄 adapter，不复制 query/fusion logic，不访问数据库。支持：

- stdio：本地 Agent process；
- stateless Streamable HTTP `/mcp`：共享部署；
- official MCP SDK structured content；
- read-only/idempotent annotations；`publish_observation` 标记 non-destructive/idempotent。

生产安全要求：OAuth/service identity、tenant scope、per-tool policy、rate limit、audit correlation ID；写 Tool schema 与 read Tool schema 分离。MCP 不是 authorization boundary，World API 必须再次鉴权。

## Agent 验收任务

Agent 不持有数据库连接，只通过 MCP 完成：

1. `find_nearby_objects` 找事故点 5km 内 5 个 UGV；
2. `get_area_situation` 获取 AOI objects + H3 totals；
3. `get_object_track` 获取历史路径；
4. `get_h3_hotspots` 找 R7 热点并以 parent 查询 R9；
5. `publish_observation` 后轮询/订阅状态事件。

`tests/scenario/mcp.test.ts` 已用官方 MCP client 和 linked in-memory transport 验证 tool discovery/call；`tests/integration/http-acceptance.ts` 在 Docker 栈验证真实 Streamable HTTP。
