# geometry-tool-service v1.0 PoC

This project-owned POC source is distributed under the MIT License. It is
vendored into GOWM from the locked `geometry-tool-service-v1.0.zip` source
archive and is the default upstream runtime for the GOWM Geometry Provider
Bridge.

一个无业务状态、无数据库依赖、contract-first 的平面 Geometry 基础服务 PoC。REST、TypeScript SDK 与 MCP 共用 `geometry-contract` 和 `geometry-core`；权威拓扑引擎是 GEOS。服务默认把同步 GEOS/WASM 调用放入可终止、可替换的 `worker_threads` 池，避免阻塞 Node.js 主事件循环。

## 结论

**CONDITIONAL GO**。唯一推荐 MVP 架构：

`REST / MCP / SDK → geometry-contract → geometry-core → bounded worker pool → GEOS C API (当前 geos-wasm 3.13)`, **No Database**。

进入生产前的条件是：在目标容器平台完成 Docker/cgroup 实机门禁、运行已准备好的 PostGIS 对照套件，并完成 geos-wasm/GEOS LGPL 与 SBOM 合规审查。当前 Work 环境已经完成 localhost 真实 socket 并发压测，但没有 Docker、PostgreSQL/PostGIS 或系统 GEOS；目标容器、TLS/proxy 和 live PostGIS 门禁仍如实标为 `BLOCKED`。

## 快速开始

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run verify:openapi
npm run acceptance
npm run start:api
```

服务监听 `http://localhost:8080`：

```bash
curl http://localhost:8080/ready
curl -X POST http://localhost:8080/v1/geometry/validate \
  -H 'content-type: application/json' \
  -d '{"input":{"geometry":{"type":"Polygon","coordinates":[[[0,0],[2,2],[0,2],[2,0],[0,0]]]}}}'
```

Docker 目标环境的一键验收（build、health/ready、PostGIS compatibility、localhost baseline + external-container socket benchmark、SBOM、完整 acceptance）：

```bash
npm run acceptance:target
```

默认保留容器供检查；显式 `TARGET_CLEANUP=1 npm run acceptance:target` 才在成功后移除。
External target benchmark 默认每档 10s/100 vertices；生产门禁建议使用 `BENCH_TARGET_DURATION=60 BENCH_TARGET_VERTICES=10000 npm run acceptance:target`，并按隔离主机容量单独验证 100k。
生产 target gate 默认要求 `trivy` image scan；只做非 promotion dry-run 时才能显式 `REQUIRE_IMAGE_SCAN=0 ALLOW_CONDITIONAL_GO=1`。最终 GO 还必须使用 ≥60s/≥10k-vertex profile并设置经审批的 `GEOMETRY_RELEASE_APPROVAL_REF`；否则脚本保留证据但返回非零。

PostGIS Spike 仅用于对照，不属于正式架构：

```bash
docker compose --profile postgis-spike up -d --build
POSTGIS_URL=postgresql://geometry:geometry@localhost:5432/geometry npm test
```

## 已实现

- 共享 contract、Zod schemas、统一错误、精度与资源策略；
- GEOS-WASM、PostGIS 和 Turf 三个 adapter spike；
- GEOS Worker Pool，真实终止超时任务并重建 Worker；等待队列有硬上限；
- validation、repair、buffer、overlay、OGC predicates、measure、simplify、precision、line/polygon/collection 等核心操作；
- 17-path OpenAPI 3.1 REST API、local/remote TypeScript SDK、13 个 MCP tools；
- 21 个 Golden cases、conformance、integration、property/fuzz、performance smoke；
- 10～1M vertices、inject 与真实 HTTP socket 并发 1/10/50/100、GeoJSON/WKB、Prepared Geometry 实测输出；
- HTTP in-flight load shedding、Prometheus queue/rejection/abort metrics、health/ready、输入预算、安全容器配置；
- CycloneDX production SBOM、扩展的 conditional live PostGIS compatibility suite、目标环境一键验收脚本。

## 验证摘要

- TypeScript typecheck：通过；
- production build：8 个 workspace 全部通过；
- tests：71 passed，29 skipped；全部 skip 都属于未配置 `POSTGIS_URL` 的 live PostGIS compatibility cases；
- OpenAPI：有效，17 paths；neutral operation allowlist 与 TypeScript contract 自动比对，所有 POST 记录 503 overload response；
- Worker Pool probe：2 workers、20/20 完成；
- 真实 localhost HTTP/1.1（独立 autocannon 进程，2 GEOS workers）：1/10/50/100 并发共 1,709 完成请求，0 error/timeout/non-2xx；100 并发 p50/p95/p99=`342.425/579.039/600.503ms`，RSS 约 377MiB；
- SBOM：CycloneDX 1.5，277 production components；其中 12 个缺少 machine-readable license 字段，保留为法务门禁；
- GEOS runtime：`3.13.0-CAPI-1.19.0`；
- 1M-vertex validate/contains/simplify 已真实运行；高风险 500k/1M overlay、union、buffer、make-valid 主动标为 `BLOCKED_RESOURCE_RISK`。

## 文档入口

- [可行性与 Q1～Q25](docs/01_FEASIBILITY_REPORT.md)
- [能力与工具分级](docs/02_GEOMETRY_CAPABILITY_MATRIX.md)
- [引擎决策](docs/03_ENGINE_EVALUATION.md)
- [Geometry Contract](docs/04_GEOMETRY_CONTRACT.md)
- [REST / SDK / MCP](docs/05_API_DESIGN.md)
- [精度、有效性与确定性](docs/06_PRECISION_VALIDITY_DESIGN.md)
- [真实基准](docs/07_PERFORMANCE_REPORT.md)
- [安全与资源限制](docs/08_SECURITY_RESOURCE_LIMITS.md)
- [唯一推荐架构](docs/09_RECOMMENDED_ARCHITECTURE.md)
- [实施路线](docs/10_IMPLEMENTATION_ROADMAP.md)
- [验收与最终 30 问](docs/11_ACCEPTANCE_REPORT.md)
- [逐操作兼容矩阵](docs/GEOMETRY_OPERATION_MATRIX.md)
- [研究证据矩阵](research/evidence-matrix.md)

## 明确边界

本服务只做 `Geometry A + Geometry B → Geometry / Scalar`，坐标原样处于同一 coordinate space。它不做 EPSG reprojection、geodesic measurement、dataset spatial join、H3、raster、routing、world model、URL fetch、文件读取或任意 SQL。
