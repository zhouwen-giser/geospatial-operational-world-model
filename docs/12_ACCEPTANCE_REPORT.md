# 12 — Acceptance Report

> Historical v1.1 acceptance report; it must not be presented as v1.2 runtime evidence.

## Release verdict

**CONDITIONAL GO** for Stage 1 engineering and read-only/影子 Agent pilot. **NOT YET ACCEPTED for production control.**

原因不是已知设计失败，而是本构建环境没有 Docker daemon/psql，无法诚实提供 PostgreSQL/PostGIS/h3-pg/MQTT 容器启动和端到端实测。领域代码、MCP adapter、simulator、C1–C10 与真实进程内 benchmark 已执行；一键 Docker acceptance 已提供。

## 执行证据

| Check | Result | Evidence |
|---|---|---|
| TypeScript type check | PASS | `npm run check` |
| Build | PASS | `npm run build` |
| Unit/scenario/MCP tests | PASS | 21 passed；DB integration 1 skipped when `RUN_DB_INTEGRATION!=1` |
| Compose YAML/static services | PASS | YAML parsed；8 required/profile services present |
| Simulator dry-run | PASS | 35 observations；Vehicle/UGV/UAV/Camera/Sensor/Incident evidence |
| C1–C10 domain scenarios | PASS | `tests/scenario/c1-c10.test.ts`, `mcp.test.ts` |
| In-process benchmark | PASS | `output/benchmarks/benchmark.json`，要求全部 scales |
| Docker Compose runtime | NOT RUN | Docker unavailable in execution environment |
| PostGIS integration | NOT RUN | conditional test + temporary-table benchmark ready |
| h3-pg + MQTT end-to-end | NOT RUN | typed migration、DB functions、Mosquitto/worker/SSE path ready |

## G1–G10 Gate Status

| Gate | 必须证明 | 当前状态 | 已有证据 | 关闭条件 |
|---|---|---|---|---|
| G1 Environment | compose/migration/seed/health | **PENDING ENV** | Dockerfile/Compose/health/migrate/seed scripts compile | target host `npm run acceptance` 全绿，记录启动时间 |
| G2 World Model | create/update/get/find/relation | **DOMAIN PASS / DB PENDING** | typed models、repository、scenario create/get；compiled SQL | HTTP acceptance 加 create/patch/search/relation assertions |
| G3 Spatial | nearby/nearest/within/intersection | **DOMAIN PASS / DB PENDING** | C1/C2 + geometry unit；PostGIS repository/index migrations | target PostGIS results + EXPLAIN/index evidence |
| G4 H3 | point/polygon/aggregation/hotspot/multi-R | **DOMAIN PASS / h3-pg PENDING** | H3 unit + C3/C9；1M H3 measured；typed migration | h3 extension/type/function + DB situation query in Docker acceptance |
| G5 Observation | ingest→event→projection→state | **DOMAIN PASS / DB PENDING** | C4/C5、fusion unit、compiled worker | HTTP ingest poll state + outbox/MQTT evidence |
| G6 Trajectory | stream→current + history | **DOMAIN PASS / DB PENDING** | C7 100×10 points、analytics code | Docker current/track + sustained 1Hz test |
| G7 Event | UGV crosses AOI, subscriber receives | **DOMAIN PASS / E2E PENDING** | C6 emits exact event | SSE/MQTT subscriber latency captured |
| G8 Agent | MCP nearby/area/track/hotspot | **MCP CONTRACT PASS / HTTP PENDING** | official MCP client lists/calls 8 tools | Docker Streamable HTTP four-tool call |
| G9 Replay | clear derived→replay→same state | **MEMORY PASS / DB PENDING** | C10 equality；subject SHA-256 replay tool compiles | target DB subject replay match；H3 full rebuild later |
| G10 Performance | real benchmark | **PARTIAL PASS** | real in-process 1M/10k observation/10k moving runs | PostGIS/h3-pg/MQTT/HTTP/storage/CPU benchmark on target |

“DOMAIN PASS” 不等于容器/数据库 pass；此表刻意保留差异。

## C1–C10 Scenario Evidence

| Scenario | Assertion | Status |
|---|---|---|
| C1 Nearby Asset | 8 UGV 中按 status/radius 找最近 5 个 AVAILABLE | PASS |
| C2 Area Situation | AOI 内 Agent/Vehicle/Incident + H3 counts | PASS |
| C3 H3 Hotspot | 200 hot vs 20 cold observations 排名 | PASS |
| C4 Obs→State | position/provenance/freshness 投影 | PASS |
| C5 Multi-source | UAV priority 胜 Camera | PASS |
| C6 Geofence | UGV outside→inside 产生一次 EnteredArea | PASS |
| C7 Trajectory | 100 vehicles × 10 ticks = 1,000 track points/current | PASS |
| C8 MCP | official client discovery + nearby invocation，无 DB | PASS |
| C9 Drill-down | R7 hotspot 的 R9 结果全为其 children | PASS |
| C10 Replay | immutable observations rebuild 相同 checksum/state | PASS |

## KPI acceptance mapping

| KPI | 当前判断 |
|---|---|
| Agent 不自建 GIS | MCP/REST contract 已证明；真实 Agent pilot pending |
| 统一 World State | 单 model/repository 证明；multi-replica DB pending |
| Observation 自动形成 State | domain pass；DB e2e pending |
| Freshness/Confidence/Provenance | pass |
| 空间事件订阅非轮询 | event generation pass；subscriber e2e pending |
| 历史轨迹 | pass domain；DB capacity pending |
| H3 理解态势 | pass |
| 快速部署 | assets ready；启动时间未实测 |
| 真实 benchmark | in-process pass；DB/bus partial |
| 后续自然集成 | stable API/event ownership design pass |

## 一键关闭待验收项

在 Docker host：

```bash
npm ci
npm run acceptance
```

脚本依次执行 typecheck、全部本地测试、真实进程内 benchmark、Compose config/build/up、h3-pg migration/type/function 验证、seed、PostGIS conditional integration、HTTP/MCP/geofence acceptance、最高 1M 临时表 PostGIS/h3-pg benchmark、100/1k/10k events/s offered-load、1,000 条 MQTT QoS 1 loopback、DB storage growth、subject replay、Docker stats 与 Mosquitto `$SYS` metrics。栈保留运行供检查；`docker compose down` 不删除 volume。

必须归档：命令输出、`output/acceptance/docker-acceptance.json`、`output/benchmarks/postgis-benchmark.json`、compose image digests、主机 CPU/RAM/disk、MQTT/PG metrics。若任何 gate 失败，production verdict 自动降为 NO-GO，直到修复并重跑。

## Known limitations / follow-up

1. DB replay 当前只比较 subject core fields；全量 H3 reconciliation 尚未实现。
2. SSE 已采用“live buffer→DB backlog→eventId dedup”切换，但仍需严格 gap/duplicate soak；客户端也必须去重。
3. PoC source priority 是 object-level；safety-critical state 需要 field-level policy。
4. `trajectory/current` 与 authoritative world current 在冲突轨迹下语义不同；Agent response 需更明确。
5. auth/tenant/RBAC/audit/retention/observability 尚未 production harden。
6. PoC Mosquitto 是单节点且匿名 listener；Stage 1 必须 TLS/auth/ACL，Stage 2 必须完成 MQTT failover 选型和演练。
7. Docker image 当前以 tag pin，正式 release 必须转 digest pin + SBOM。

## Sign-off rule

- 现在：允许继续 Stage 1、运行开发环境、进行 read-only shadow Agent pilot。
- G1–G10 target-host evidence 全 PASS 后：允许 controlled MVP。
- Week 4 security/retention/replay/7-day soak 后：允许低风险 operational use。
- Week 8 HA/RBAC/audit/DR/30-day capacity 后：才允许称 Operational platform。
