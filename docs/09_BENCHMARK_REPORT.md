# 09 — Benchmark Report

> Historical v1.1 evidence; it is not a GOWM+ v1.2 MobilityDB performance claim.

## 判读结论

代码路径可在单进程内处理本任务要求的所有规模档位，1M current objects 的保守 O(N) nearby p95 为 7.80ms、nearest p95 26.47ms；10k Observation projection 实测 7,162.31/s，p95 0.19ms。结果证明领域模型/H3/API 编排没有明显算法阻塞，但**不证明 PostGIS/h3-pg、Docker 网络和 MQTT 已达到相同数字**。

当前 release 的性能验收是 **CONDITIONAL**：真实 PostGIS 脚本已提供，必须在目标 Docker host 运行并把结果补入 `output/benchmarks/postgis-benchmark.json`。

## 测试环境

| 项 | 值 |
|---|---|
| Run | 2026-08-12T00:42:34.773Z — 00:42:38.954Z |
| Mode | `in-process-domain-and-H3` |
| Node | v24.14.0 |
| OS/kernel | Linux 6.18.35 |
| CPU | AMD EPYC 9V74，9 logical CPUs visible |
| Memory | 17,106,231,296 bytes visible |
| Final RSS | 336,953,344 bytes (~321 MiB) |
| CPU | user 4,632.3ms / system 90.6ms |
| Docker/PostgreSQL | unavailable in execution container |

原始机器可读结果：`output/benchmarks/benchmark.json`；自动生成摘要：`output/benchmarks/benchmark.md`。

## 方法

### Spatial

用 deterministic pseudo-random typed arrays 生成北京附近 1k/10k/100k/1M points。对每档执行 7–15 次 nearby、rectangle within、nearest 的保守单线程 O(N) 扫描，并全量做 H3 R9 aggregation。这里故意不伪造 index；目标是给上层 geometry/H3 算法一个可重现下界。

### Observation

用与服务共享的 `MemoryWorldModel` 完整执行 dedup、fusion、state/geometry、trajectory、R7–R10 situation 和 events；100/1k/10k Observation 各一次批量 run，记录每条 projection latency。它比纯 parse benchmark 更接近领域路径，但没有 SQL/serialization/broker。

### Moving objects

Simulator 生成 10/100/1k/10k 个对象的一个 position tick，完整投影后抽样 current query。C7 的持续 100 vehicles × 10 ticks 另由场景测试验证 track 分离。

## 实测结果

### Spatial core

| Objects | Nearby p50/p95/p99 ms | Within p50/p95/p99 ms | Nearest p50/p95/p99 ms | H3 aggregate ms | H3 objects/s | RSS Δ MiB |
|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 0.01 / 0.14 / 0.14 | 0.01 / 0.21 / 0.21 | 0.04 / 0.78 / 0.78 | 10.08 | 99,233.02 | 9.5 |
| 10,000 | 0.04 / 0.14 / 0.14 | 0.10 / 0.12 / 0.12 | 0.25 / 1.66 / 1.66 | 15.12 | 661,367.66 | 4.8 |
| 100,000 | 0.44 / 0.49 / 0.49 | 1.03 / 1.55 / 1.55 | 1.92 / 2.31 / 2.31 | 106.77 | 936,616.27 | 2.4 |
| 1,000,000 | 4.28 / 7.80 / 7.80 | 10.87 / 11.07 / 11.07 | 19.64 / 26.47 / 26.47 | 1,041.12 | 960,503.13 | 15.2 |

1k 的 within/nearest p95 包含 JIT/GC warm-up outlier，样本量小，不能用于容量线性拟合；10k 之后趋势更稳定。PostGIS benchmark 有 warm-up + 30 samples。

### Observation projection

| Observations | Elapsed ms | Rate/s | Projection p50/p95/p99 ms | RSS Δ MiB |
|---:|---:|---:|---:|---:|
| 100 | 7.46 | 13,397.31 | 0.04 / 0.11 / 0.18 | 0.1 |
| 1,000 | 65.00 | 15,383.50 | 0.04 / 0.08 / 0.20 | 12.8 |
| 10,000 | 1,396.20 | 7,162.31 | 0.12 / 0.19 / 0.28 | 149.2 |

10k run 中 memory model 保留 objects/track/events/cells，RSS 增长不能外推为 PostgreSQL row size。它提示 event-rich in-memory cache 不应无限保留。

### Moving objects

| Moving objects | Position rate/s | Current query p50/p95/p99 ms | RSS Δ MiB |
|---:|---:|---:|---:|
| 10 | 14,648.88 | 0.01 / 0.11 / 0.11 | 0.0 |
| 100 | 26,371.51 | 0.01 / 0.01 / 0.01 | 0.0 |
| 1,000 | 26,598.13 | 0.01 / 0.01 / 0.01 | 0.4 |
| 10,000 | 10,464.60 | 0.01 / 0.01 / 0.01 | 63.6 |

## 指标覆盖

| 要求指标 | 当前证据 | 状态 |
|---|---|---|
| ingest_rate | memory full-domain rate | measured |
| projection_latency | per observation memory p50/p95/p99 | measured |
| event_latency | 需 Ingest→outbox→MQTT QoS 1→subscriber | pending Docker |
| query p50/p95/p99 | in-process spatial/current | measured baseline |
| spatial_query_time | O(N) baseline；PostGIS script ready | partial |
| h3_query_time | full aggregation time | measured |
| trajectory_query_time | current query measured；DB track pending | partial |
| storage_growth | 只有模型估算，非 DB size | pending Docker |
| CPU/memory | process metrics/RSS | measured |

## Docker/PostGIS benchmark

`tests/performance/postgis-benchmark.ts` 在一个连接内创建 TEMP tables，不污染产品数据，分别装载 1k/10k/100k/1M points，建立 geometry/geography GiST 与 h3-pg `h3index` B-tree，warm up 后对 nearby/within/nearest、exact cell、R9→R7 parent filter 与 polygon-to-cells 各采样 30 次，写入 JSON。

```bash
docker compose up -d --build
docker compose run --rm world-api node dist/scripts/seed.js
npm run acceptance
```

低资源机器：

```bash
BENCH_MAX_OBJECTS=100000 npm run acceptance
```

`tests/performance/http-load.ts` 已实现 Observation HTTP 100/1k/10k events/s offered-load（默认各 1 秒，可调 duration/concurrency）、request p50/p95/p99、最后一条 projection wait 和 `pg_total_relation_size` 增长；低于 target 会写 `targetMet=false`，不会被隐藏。`mqtt-benchmark.ts` 发送默认 1,000 条 QoS 1 Event 并实测 publish/PUBACK/subscriber loopback p50/p95/p99。Acceptance 同时保存 `docker stats` 与 Mosquitto `$SYS/broker/#` 快照。仍需在目标环境补充 100 vehicles 1Hz 1h soak 与 EXPLAIN buffers。

## SLO 与迁移 triggers

建议 Stage 1 SLO（需业务批准）：current/nearby/in-area p95 <100ms、p99 <250ms；Observation accepted→state p95 <500ms；geofence event subscriber p95 <1s；MCP overhead p95 <50ms（不含 API）。

- TimescaleDB：>100M retained trajectory points 或 indexed/partitioned PostgreSQL track p95 >200ms。
- ClickHouse：>1B points，或 sustained >20k points/s 且长周期 analytical p95 失败。
- Kafka/Redpanda：sustained accepted ingress >50k events/s 30min，或出现多区域 partitioned log/long retention 强需求。
- H3 parent materialization：h3-pg parent filtering/rollup p95 >50ms（调优后）时增加 parent columns/B-tree。

这些是容量决策门槛，不是当前实测极限；只有目标硬件 load test 可将其转成正式切换点。
