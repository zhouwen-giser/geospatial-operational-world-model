# 08 — Technology Decisions

> Historical v1.1 baseline. The v1.2 runtime is PostgreSQL 18/PostGIS 3.6/MobilityDB 1.3/h3-pg 4.5.

## Recommended Stack

| Layer | MVP choice | PoC pin | Why |
|---|---|---|---|
| Language/runtime | TypeScript / Node.js | TS 5.9, Node 22 build image | 快速 schema/API/MCP，共享类型 |
| API | Fastify | 5.11.3 | 低开销、简单 validation/health |
| Database | PostgreSQL + PostGIS + h3-pg | PG 17 / PostGIS 3.5 / h3-pg 4.5.0 | 一库覆盖 state/JSON/relations/spatial/trajectory/H3 |
| H3 | h3-pg + h3-js adapter | 4.5.0 | DB 原生 `h3index`/hierarchy；JS 仅边界与无 DB 测试 |
| Event bus | MQTT 5 / Eclipse Mosquitto | broker 2.1.2, mqtt.js 5.15.2 | 多 IoT 团队共同协议、QoS 1 live delivery、低运维 |
| Agent interface | MCP SDK + REST/SSE/MQTT | MCP SDK 1.30 | Agent 隔离底层；标准同步/订阅接口 |
| Packaging | Docker Compose | v2 spec | <10min dev target，不引入 K8s |

生产升级前重新核验 Node LTS policy、镜像 digest、CVE 与 SBOM；PoC 版本不是永久生产 pin。

## ADR-001 — Minimal Twin Core vs Eclipse Ditto

### Spike A: Minimal custom core（已实现）

包含 registry、state、geometry、relation、global version、freshness/provenance、optimistic update、Observation projection 与 event outbox。核心与 PostGIS 同事务；Agent response 可直接设计。

### Spike B: Eclipse Ditto（官方文档/架构 spike）

确认可复用：Thing/Feature、Policy、Twin/Live channel、Search、WebSocket/SSE/HTTP、Connectivity 的 MQTT/Kafka/AMQP/HTTP。仍需另建 PostGIS spatial schema、H3 situation、trajectory store 和 Observation fusion。官方架构是 Gateway/Things/Things Search/Policies/Connectivity 多服务 + MongoDB。

| 维度 | Minimal Core | Ditto | 胜者/理由 |
|---|---:|---:|---|
| Day-1 complexity | 5 | 2 | 一个 app + Postgres vs 多服务/Mongo |
| GOWM integration effort | 5 | 2 | 模型直接围绕 Observation/Spatial |
| Spatial integration | 5 | 2 | PostGIS 同事务；Ditto 需外部索引同步 |
| Event model | 4 | 5 | Ditto成熟，但 GOWM 需 causation/worldVersion |
| Agent API | 5 | 3 | 可直接给 Agent-friendly summary |
| Operational overhead | 5 | 2 | 少一个数据库和服务集群 |
| Scalability | 3 | 5 | Ditto 有成熟 cluster architecture |
| Authorization | 2 | 5 | Ditto Policy 明显更强 |
| Future device connectivity | 2 | 5 | Ditto Connectivity 更强 |
| 双 Source of Truth 风险 | 5 | 2 | Minimal state/geometry 同库 |

**Decision: DO NOT ADOPT for Stage 0/1.**

不是“部分引入 Ditto core”：那仍会支付集群/Mongo/同步成本却用不到完整价值。Stage 2 只有在以下任一条件成立时重开：>100k managed device twins 需要 per-feature policy；至少三种外部工业协议适配成为主成本；live/desired/reported channel 有真实 command KPI。新 spike 必须用同一 C1–C10 与运维成本 benchmark。

若未来采用，字段 ownership 必须是单向：Ditto 仅 device configuration/desired-reported/policy；GOWM 仅 operational geometry/state/situation/trajectory。禁止同字段双写。

## ADR-002 — Storage Architecture

| 方案 | Fast delivery | Spatial | Current state | Trajectory | Ops | 双写风险 | 决策 |
|---|---:|---:|---:|---:|---:|---:|---|
| A PostgreSQL + PostGIS | 5 | 5 | 5 | 3 | 5 | 5 | **MVP** |
| B A + TimescaleDB | 4 | 5 | 5 | 5 | 4 | 5 | threshold 后原位扩展 |
| C PostGIS + ClickHouse | 2 | 5/3 | 5 | 5 | 2 | 2 | 大 OLAP 派生库 |
| D Ditto + PostGIS + TS store | 1 | 4 | 4 | 5 | 1 | 1 | 不采用 |

Timescale trigger：>100M retained trajectory points，或目标 window track p95 >200ms 且原生 partition/index/vacuum 已调优。ClickHouse trigger：>1B retained points，或 sustained >20k trajectory points/s 且长周期 analytics SLO 失败。门槛是明确容量规划估算；目标硬件 DB benchmark 后校准。

## ADR-003 — Event Bus

| 维度 | JetStream | Kafka | Redpanda | MQTT |
|---|---:|---:|---:|---:|
| 部署复杂度（高分简单） | 5 | 2 | 3 | 5 |
| 开发复杂度 | 5 | 3 | 3 | 5 |
| durability | 4 | 5 | 5 | 2 |
| replay | 4 | 5 | 5 | 2 |
| ordering | 4 | 5 | 5 | 3 |
| consumer groups | 4 | 5 | 5 | 2 |
| retention | 4 | 5 | 5 | 2 |
| throughput | 4 | 5 | 5 | 3 |
| IoT compatibility | 4 | 2 | 2 | 5 |
| Agent compatibility | 5 | 3 | 3 | 4 |
| 运维成本 | 5 | 2 | 3 | 5 |

**Decision: MQTT 5 / Eclipse Mosquitto.** PostgreSQL observation/event tables 是记录系统与 replay source；MQTT 是 QoS 1 live transport，不承诺任意历史 replay。所有 consumer 按 `observationId/eventId` 幂等，SSE 用“先订阅并缓冲 live，再读 DB backlog，最后去重合并”关闭竞态窗口。

Kafka/Redpanda trigger：目标硬件持续 accepted ingress >50k events/s 30min，或必须支持组织级 Kafka ecosystem、多区域分区日志/长期 replay。优先 Kafka（Apache license/生态）；只有 JVM 运维是已量化痛点且 Redpanda license 已通过法务时选 Redpanda。NATS/JetStream 不进入 v1.1 基线，避免多 broker/多 SDK。

## ADR-004 — H3 implementation

**MVP: h3-pg 4.5.0 + native `h3index` R7–R10 columns.** 自定义 PostGIS 镜像安装 `postgresql-17-h3` 并在构建时校验上游版本；migration 启用 `h3/h3_postgis`，将 v1.0 text 列原位升级为 `h3index`。Point projection、polygon-to-cells、grid disk、parent/children 与 ranked parent filter 在数据库执行。B-tree 用于精确 cell/time 查询；4.5.0 的 experimental GiST operator class 不进入基线。`h3-js` 只用于内存场景、输入 resolution 校验和 API boundary 组装。PostGIS geometry 始终权威，H3 始终可重建。

## ADR-005 — Interfaces

- REST：标准同步 query/command，生态最大，P0。
- MCP：Agent tool layer，P0；薄 adapter。
- SSE：数据库 backlog + MQTT live 的 filtered subscription，P0。
- Native MQTT 5：IoT/Agent live subscription，P0；QoS 1、stable topic、client-side eventId dedup。
- gRPC：不在 MVP；只有 typed streaming/内部性能证据出现再加。
- A2A：不在 MVP；它解决 Agent 协作，不解决 world-state API。

## Why not alternatives now

| Technology | 不采用原因 | 何时再看 |
|---|---|---|
| Elasticsearch | Spatial/search 能力重叠、双索引一致性 | 文本检索成为独立 P0 且 PG FTS 失败 |
| Neo4j | Typed relations 不需要任意 graph traversal | ontology decision gate 满足 |
| Kubernetes | 还没有 HA/多环境部署需求，降低 Day-1 | Stage 2 operational SLO/平台标准要求 |
| Full SensorThings server | OData/conformance scope 与 Agent KPI 不匹配 | 外部客户强制 OGC conformance |
| Complex stream processor | 当前 projector 足够，增加状态/运维 | 多窗口/CEP 吞吐实际超过 worker headroom |
| Redis | current state 已有 indexed Postgres，cache 会引入失效问题 | query p95 证实需要且 versioned cache 设计完成 |

## License / operational notes

- GOWM source MIT；PostGIS GPL 是独立数据库组件，分发镜像时保留 notices/source obligations。
- h3-pg 为 Apache-2.0；Mosquitto 为 EPL-2.0/EDL-1.0，镜像分发需保留相应 notices。
- Redpanda BSL/enterprise、Timescale mixed license 功能必须逐项法务核验。
- 正式 release 生成 SBOM、image digests、dependency licenses；当前 `package-lock.json` 固定 Node dependencies。
- PoC Mosquitto 允许匿名访问只用于本地 Compose；Stage 1 必须启用 TLS、身份认证、per-topic ACL 和 credential rotation。
