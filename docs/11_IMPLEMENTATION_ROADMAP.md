# 11 — Implementation Roadmap

> Historical v1.1 roadmap. v1.2 promotion gates are in documents 14 and 16.

## 原则

Roadmap 以 Agent 可消费闭环排序，不以服务数排序。建议核心团队 2 名 backend/data engineer + 0.5 名 IoT integration + 0.5 名 operations/security；单人也可执行但 Week 2–8 顺延。

本仓库已提供 Stage 0 工程基线。下表既是从零实施计划，也是把 PoC 推到真实环境的收敛顺序。

## Day 1

交付：

- Docker Compose PostGIS + h3-pg + migration + health；
- `world_object/state/geometry` 最小 schema；
- Point/Polygon seed 和 simulator skeleton；
- create/get object；
- worldVersion、GeoJSON/SRID contract。

退出标准：新机器 `docker compose up -d --build` <10 min；migration checksum 固定；health 显示 PostGIS/h3-pg version；同一对象两次读取一致。

当前仓库：代码/Compose 已完成；目标 host 运行证据待补。

## Day 3

交付：

- nearby/nearest/in-area/containing/distance；
- Observation 1.0 + validation/dedup/persist；
- source registry 草案；
- 10 UGV + Camera/Sensor/Incident seed；
- first Agent response `summary/facts/context`。

退出标准：C1 nearby available UGV；invalid geometry/time 422；duplicate 不产生第二条 observation。

当前仓库：完成。

## Week 1

交付：

- durable projection queue + deterministic fusion；
- Observation→Current State→Spatial Query 闭环；
- Freshness/Confidence/Provenance；
- H3 R7–R10 projection、area/hotspot/drill-down；
- immutable Event/outbox + MQTT QoS 1 topics；
- unit/scenario CI。

退出标准：C2–C5/C9；多个 Agent 读取同一 worldVersion；worker retry 无重复 state/event；R7 hotspot→R9 child。

最快投入：Week 1 末允许非安全关键、read-only Agent 影子使用。

## Week 2

交付：

- Trajectory current/history separation、track/recent/distance；
- geofence membership + enter/exit；
- SSE/native event subscription；
- MCP 8 个首批 tool；
- simulator 100 vehicles 1Hz；
- C6–C8 integration acceptance。

退出标准：UGV-3 crossing e2e event；100 vehicles × 1Hz soak 不丢 observation；Agent 通过 MCP 完成 nearby/area/track/hotspot，零 DB access。

最快投入：Week 2 末允许一个受控真实 IoT Agent 使用，必须人工审批动作。

## Week 4

交付：

- target-hardware 1k/10k/100k/1M PostGIS benchmark；100/1k/10k events/s step test；
- multi-source field policy、clock skew metrics；
- subject/full replay shadow rebuild + checksum；
- per-type freshness SLA；evidence[]；
- partition/retention/storage growth；
- auth/tenant/audit、OpenTelemetry metrics；
- query guardrails/EXPLAIN regression。

退出标准：G1–G10 全 PASS；目标 SLO 达标；7-day soak；replay core + H3 counters 一致；failure injection（MQTT down/worker restart/duplicate storm）通过，broker outage 期间事件可由 DB backlog 补偿。

## Week 8

交付：

- PostgreSQL HA/PITR/restore drill；MQTT HA/failover 产品与部署验证（协议保持 MQTT 5）；
- RBAC/service identity/secrets；
- backpressure、DLQ/reprocess、schema compatibility governance；
- SLO dashboards/alerts/runbooks/on-call；
- 30-day retention validation 与 capacity model；
- two real source adapters、Coverage Planner/H3 Toolkit contract；
- security/load/chaos review。

退出标准：30-day soak 或等价加速测试；RPO/RTO drill；rolling migration/rollback；生产变更审批；Agent action policy 签字。此时才称 Stage 2 Operational。

## Work Breakdown

| Workstream | P0 | P1 | Deferred |
|---|---|---|---|
| World | registry/state/version/freshness/provenance | field policy/evidence[] | ontology/KG |
| Spatial | nearby/nearest/area/distance | route/intersection/snap | routing solver/3D |
| H3 | R7–R10 counts/hotspot | coverage gap/reconciliation | prediction |
| Observation | schema/dedup/fusion/queue | SensorThings adapter/full replay | complex Bayesian fusion |
| Event | outbox/MQTT QoS 1/SSE/geofence | near/coverage events、broker failover | workflow engine |
| Trajectory | current/track/recent | dwell/deviation/partition | ClickHouse until trigger |
| Agent | REST/MCP/subscribe | tool pagination/policy | A2A until need |

## Definition of Done

每个能力必须同时具备：schema、implementation、migration、failure behavior、Agent-friendly response、unit/integration/scenario test、measured latency、freshness/provenance、docs/runbook。只完成 API 草案或 happy path 不能进入“Done”。

## Decision checkpoints

- Week 2：Agent read-only value review；若 Agent 仍需自行 GIS/merge，修 Tool contract，不加新平台。
- Week 4：storage/bus benchmark；只有 trigger 命中才引入 Timescale/Kafka/ClickHouse。
- Week 8：Ditto decision gate；只有 Policy/Connectivity 进入 Top-10 value 才重新 spike。
- 每阶段：禁止用“架构先进”替代 KPI-1–KPI-10 的证据。
