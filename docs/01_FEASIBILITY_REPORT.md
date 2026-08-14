# 01 — Feasibility Report

> Historical v1.1 baseline. For v1.2 architecture and validation, documents 13–16 and migration 009 are normative.

## 执行结论

**工程可行性 GO；当前 release 投产 CONDITIONAL GO**。值得建设独立的 Geospatial Operational World Model，但它应是一个窄而深的运行状态平台，不是提前建设 Digital Twin/Knowledge Graph 大平台。

最小生产方向：TypeScript/Node.js + PostgreSQL/PostGIS + h3-pg + MQTT 5/Mosquitto + REST/SSE + MCP。`h3-js` 仅保留在内存测试、输入校验与边界组装侧；持久 H3 数据使用 `h3index`。第一阶段不采用 Eclipse Ditto、TimescaleDB、ClickHouse、Kafka、Redpanda、NATS、Neo4j、Elasticsearch 或 Kubernetes。

PoC 已证明领域闭环、Agent 屏蔽底层实现和百万对象规模的进程内算法基线可行；由于创建环境没有 Docker，数据库/消息总线端到端门禁仍需在有 Docker 的机器运行 `npm run acceptance`。这使结论是“工程方向 GO、生产投用受环境验收门约束”，而不是无条件生产签字。

## Q1–Q20 明确回答

### World Model

**Q1. 最小 World Object 模型是什么？**

身份表 `world_object(id,type,subtype,properties)` + 单行当前状态 `world_object_state` + 单行权威几何 `world_object_geometry` + `world_relation`。API 组装成 `id/type/subtype/geometry/h3/state/properties/relations/confidence/observedAt/updatedAt/version/provenance/freshnessMs/stale`。Observation、Event、Trajectory 分表，不塞进对象。

**Q2. 是否需要完整 Ontology？**

不需要。Stage 0/1 使用可扩展 `Typed Object + Typed Relation + JSON Schema/Zod validation` 足够。只有跨组织语义推理、继承约束和 ontology governance 成为已证明需求时，才评估知识图谱。

**Q3. 是否应该使用 Eclipse Ditto？**

MVP **DO NOT ADOPT**。Ditto 强项是设备 Twin、Policy、协议 Connectivity、Twin/Live channel；GOWM 的 P0 是 PostGIS 空间、H3、Observation projection 和轨迹。Ditto 仍需 PostGIS，并引入五类服务、MongoDB 和状态同步问题。

**Q4. 若未来使用 Ditto，如何分工且避免双 Source of Truth？**

只允许 Ditto 负责设备声明/desired-reported Twin、Policy 和 protocol connectivity；GOWM/PostGIS 负责几何、运行态势、关系、轨迹和 Observation-derived authoritative state。通过单向 adapter 投影，字段必须有 ownership registry；同一字段绝不可双写。Ditto Search 不承担几何查询。MVP 不做此扩展。

**Q5. 自研最小 Twin Core 成本？**

PoC 代码已实现核心。工程估算：2 名熟悉 TypeScript/Postgres 的工程师，3–5 个工作日可完成 registry/state/version/relations/freshness/provenance 的可用内核，2–3 周加入 API、幂等 projection、事件、测试与 observability，4–8 周完成 production hardening。代价是策略/RBAC/设备协议连接需后续补齐，但这些不属于首批价值路径。

### Spatial

**Q6. PostGIS 是否足够？**

是，Stage 0/1 足够。GiST、Geography 距离、geometry topology、KNN 能直接覆盖 P0/P1。百万对象真实 PostGIS 数字由提供的 `benchmark:postgis` 在目标硬件复验；当前进程内 1M O(N) baseline 已达到 nearby p95 7.80 ms、within p95 11.07 ms、nearest p95 26.47 ms，说明算法/API 本身不是阻塞点，但不能将其冒充 DB 结果。

**Q7. 高价值 Spatial API？**

`get_object`、`find_objects`、`find_objects_in_area`、`find_objects_near`、`find_nearest_objects`、`objects_along_route`、`objects_near_route`、`get_containing_areas`、`get_intersections`、`calculate_distance`、`get_area_summary`。P0 优先 nearby/nearest/in-area/containing/distance。

**Q8. Geometry/H3/Relation 如何统一？**

Geometry 是 EPSG:4326 权威事实；H3 R7–R10 是由 h3-pg 从 geometry centroid/point 生成、以原生 `h3index` 存储且可重建的派生索引；精确空间关系 `locatedIn/near/contains/locatedOn` query-time 计算，稳定业务关系持久化。三者通过 object id + worldVersion 关联，不混为 JSON。

### H3 Situation

**Q9. H3 是否为统一 Situation Index？**

是，作为统一的派生态势索引；不是唯一空间索引，也不是权威几何。

**Q10. 哪些指标预计算？**

`agent_count/vehicle_count/sensor_count/incident_count/observation_count/unique_observer_count/last_observed_at` 与可从它们稳定推导的 activity/freshness 基础项。移动时做旧 cell 减计、新 cell 增计，Observation append 做计数。

**Q11. 哪些 query-time 计算？**

场景化 risk 权重、任务专属 filter、指定时间窗、跨 cell 去重后的 AOI totals、coverage threshold、复杂 exposure/intersection。当前 PoC 的 risk/coverage/activity/freshness 分数由数据库 view/query 动态计算。

**Q12. 不同 Resolution？**

每个 Point 同时投影 R7/R8/R9/R10；每层独立计数；h3-pg `h3_cell_to_parent/h3_cell_to_children` 支持数据库内 roll-up/drill-down。流程是 R7 找 hotspot，再以 `parentCell` 查询 R8/R9，避免 object fan-out。

### Observation / Event

**Q13. Observation、Event、StateChange 边界？**

Observation 是某观察者在 event time 对世界的有置信度陈述，immutable。Event 是系统确认发生/处理的事实通知，含 causation/worldVersion，可 replay。StateChange 是 Event 的子类语义，只有 Projection 实际改变 authoritative current state 时产生；ObservationReceived 不等于 StateChange。

**Q14. SensorThings？**

兼容 Sensing 1.1 的 Observation/Thing/Location/Sensor/ObservedProperty/Datastream/FOI 语义映射；保留外部 ID 与原始 payload。Tasking 仅预留 command adapter。WebSub 可映射到事件订阅。绝不在 MVP 实现完整 OData/Full OGC Server 或宣称 conformance。

**Q15. Event Bus 选什么？**

**MQTT 5 + Eclipse Mosquitto**。它直接匹配 IoT 设备和多团队订阅，PoC 使用 QoS 1、持久 broker 数据和稳定主题。必须明确：MQTT 不是任意历史 replay log；`world_observation/world_event` 才是持久记录与 replay source，SSE 先订阅并缓冲 MQTT live，再读数据库 backlog 并按 eventId 去重合并。Kafka/Redpanda 仅在吞吐或组织级分区日志 trigger 后再选；NATS 不进入 v1.1 基线。

**Q16. duplicate/out-of-order/late？**

`observationId` 唯一键提供幂等；投影事务锁定 subject；比较 source priority、observedAt、confidence、observationId tie-break；超未来/非法 geometry 拒绝；允许的迟到 Observation 仍归档和进入历史轨迹，但只有胜出才更新 Current State；队列 at-least-once 依靠 `projected_at` 幂等；replay 按 observedAt/receivedAt/id 稳定排序。

### Trajectory

**Q17. 存储选什么？**

MVP 选 PostgreSQL/PostGIS 原生表，`entity_id, observed_at` B-tree + BRIN(time) + GiST(geometry) + observation unique。先不要 Timescale/ClickHouse。

**Q18. Current 与历史是否分模型？**

必须分。`world_object_state/world_object_geometry` 只有最新位置；`trajectory_point` append-only 保存所有有效 position observations。Current 查询 O(1) 单行，track 走 entity/time index。

### Agent Integration

**Q19. 提供哪些接口？**

Stage 1：REST（同步读写）、MCP（LLM/Agent tools）、SSE（数据库 backlog + MQTT live）和原生 MQTT topic（事件订阅）。内部 worker 可后续用 gRPC，但当前无价值；A2A 在 Agent 协作协议稳定且出现跨组织任务委派需求前不实现。

**Q20. 首批 Tools？**

P0：`world.get_object`、`world.find_objects`、`world.get_state`、`world.get_freshness`、`world.get_provenance`、`spatial.find_nearby`、`spatial.find_nearest`、`spatial.find_in_area`、`spatial.get_containing_area`、`spatial.distance`、`situation.get_cell`、`situation.get_area`、`situation.get_hotspots`、`observation.publish`、`observation.query`、`event.subscribe`、`trajectory.get_current_position`、`trajectory.get_track`、`trajectory.get_recent_track`。P1：route query、coverage gap、stop/dwell/deviation。

## 最终 20 项结论

| # | 问题 | 明确结论 |
|---:|---|---|
| 1 | 独立 World Model Platform？ | 值得，**GO**；保持 operational scope |
| 2 | 最小架构？ | TS + PostgreSQL/PostGIS + h3-pg + MQTT + REST/SSE/MCP |
| 3 | 首批 Tools？ | P0 的 19 个，先投放 nearby/state/area/observation/event/track/hotspot |
| 4 | Ditto？ | MVP 不采用；Stage 2 条件 spike |
| 5 | SensorThings？ | Sensing 1.1 schema/semantic mapping，不做 full server |
| 6 | H3 角色？ | 派生、多分辨率 Situation Index |
| 7 | PostGIS？ | 第一阶段足够且是空间事实源 |
| 8 | TimescaleDB？ | 不需要；>100M retained points 或 trajectory p95 >200ms 后评估 |
| 9 | ClickHouse？ | 不需要；>1B points 或 sustained >20k points/s 且 OLAP SLO 失败后评估 |
| 10 | Event Bus？ | MQTT 5 / Mosquitto；历史 replay 由 PostgreSQL 提供 |
| 11 | Observation→State？ | validate→dedup→persist→ordered fusion/project→versioned state→event |
| 12 | Freshness？ | `now-lastObservedAt` + type/SLA threshold + `stale` |
| 13 | Provenance？ | confidence/source/sourceObservationId/observedAt/receivedAt；P1 evidence[] |
| 14 | Trajectory？ | 独立 append table，current 不随 track 增长 |
| 15 | Replay？ | immutable observations + deterministic sort/fusion；按 subject hash 验证核心字段 |
| 16 | MCP？ | Stateless Streamable HTTP + stdio adapter，调用 REST，不接 DB |
| 17 | 最快投用？ | 1 周可给受控 Agent 试用；2 周可形成首个现场 MVP；4–8 周 hardening |
| 18 | 最大风险？ | 多源语义/时间/信任策略错误导致“统一但错误”的状态；其次是未在目标硬件完成 DB/bus benchmark |
| 19 | 下一阶段？ | Docker 目标环境验收、真实 source mapping、RBAC/audit/metrics、30 天 soak |
| 20 | 不该建设？ | KG/Ontology 大平台、复杂 fusion、3D/simulation/planner/solver/full OGC/K8s |

## GO 的必要约束

上线前必须通过：目标环境 `npm run acceptance`；真实设备时钟偏差统计；每类 state 字段的 source ownership/freshness SLA；MQTT connection/session/queued-message 与 PostgreSQL outbox lag 告警；至少 7 天 replay soak；安全评审。任一核心状态缺少 provenance 或 freshness 时，Agent API 必须显式标成 unknown/stale，不能静默当真。
