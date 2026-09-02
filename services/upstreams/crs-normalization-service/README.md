# WGS84 Coordinate Normalization Service

This project-owned POC source is distributed under the MIT License. It is
vendored into GOWM from the locked `crs-normalization-service-v1.0.zip` source
archive and is the default upstream runtime for the GOWM CRS Provider Bridge.

面向多系统与 IoT-Agent 平台的极薄坐标入口服务。它只做一件事：将受支持
EPSG CRS 下的坐标与 GeoJSON 统一转换为 `EPSG:4326`，并固定输出
`[longitude, latitude]`。

## 结论

项目结论为 **CONDITIONAL GO**：技术路线与 MVP 已通过真实转换、REST、SDK、MCP、
Golden Test 和最高 1,000,000 点基准；投产前只剩两个外部条件：

1. 在具备 Docker 的环境完成一次干净的 `docker compose build/up` 验证；
2. 对需要高精度 Grid 的目标地区，按部署清单安装并验收授权 Grid，或明确保持失败关闭。

唯一推荐架构是：

```text
REST / TypeScript SDK / MCP
              ↓
       TypeScript Core
              ↓
   gdal-async native binding
              ↓
       PROJ 9.5.1 + proj.db
              ↓
   EPSG:4326 [longitude, latitude]
```

GDAL 仅作为成熟的 Node→PROJ 原生绑定载体；服务不使用 raster、数据库、PostGIS、
Kafka，也不在运行时下载 Grid。

## 快速启动

要求 Node.js 22+。

```bash
npm install
npm run build
npm test
npm start
```

服务默认监听 `http://localhost:8080`：

```bash
curl -sS http://localhost:8080/health/ready

curl -sS -X POST http://localhost:8080/v1/normalize/point \
  -H 'content-type: application/json' \
  -d '{
    "sourceCrs":"EPSG:3857",
    "coordinate":[15550408.91,4257980.73]
  }'
```

典型输出：

```json
{
  "coordinate": [139.69169998161388, 35.68949998406468],
  "crs": "EPSG:4326",
  "axisOrder": ["longitude", "latitude"],
  "coordinateCount": 1,
  "zTransformed": false,
  "transformation": {
    "engine": "PROJ",
    "engineVersion": "9.5.1",
    "integration": "gdal-async",
    "integrationVersion": "3.12.3",
    "sourceCrs": "EPSG:3857",
    "targetCrs": "EPSG:4326",
    "strictBestOperation": true,
    "networkEnabled": false,
    "cacheHit": false
  },
  "warnings": []
}
```

Docker 环境中：

```bash
docker compose up -d --build
curl -sS http://localhost:8080/health/ready
```

当前执行环境没有 Docker，所以上述容器门禁保留为外部验收项，详见
[`docs/09_ACCEPTANCE_REPORT.md`](docs/09_ACCEPTANCE_REPORT.md)。

## API 与 SDK

正式端点：

- `POST /v1/normalize/point`
- `POST /v1/normalize/points`
- `POST /v1/normalize/geometry`
- `POST /v1/normalize/feature`
- `POST /v1/normalize/feature-collection`
- `GET /v1/crs/{epsg}`
- `POST /v1/normalize`（便利入口，显式端点仍是冻结契约）

OpenAPI 3.1：[`openapi/openapi.json`](openapi/openapi.json)，运行时也可访问
`GET /openapi.json`。

TypeScript SDK：

```ts
import { CrsClient } from "@geospatial/crs-sdk";

const crs = new CrsClient({ baseUrl: "http://localhost:8080" });
const result = await crs.normalizePoint({
  sourceCrs: "EPSG:3857",
  coordinate: [15550408.91, 4257980.73]
});
```

MCP 工具：

- `crs.normalize_point`
- `crs.normalize_points`
- `crs.normalize_geometry`
- `crs.check_source_crs`

启动 MCP stdio server：`npm run start:mcp`。

## 固定策略

- P0 输入标识只接受 `EPSG:<code>` 与 `WGS84` 别名；WKT2/PROJJSON 进入 P1。
- 外部输入使用 traditional GIS order；地理 CRS 是 `[longitude, latitude]`，投影 CRS 是
  `[easting, northing]`。
- 输出永远是 `EPSG:4326 [longitude, latitude]`，调用方不能改目标 CRS 或轴顺序。
- 只转换 x/y；第三、第四维原值保留，并返回 `Z_NOT_TRANSFORMED`。
- GeoJSON `bbox` 会删除并返回 `BBOX_DROPPED`，避免保留错误的源 CRS 范围。
- `PROJ_NETWORK=OFF`、`PROJ_ONLY_BEST_DEFAULT=YES`：最佳操作所需 Grid 缺失时失败关闭，
  不允许静默 Helmert/ballpark 降级。

## 已实测性能与限制

Linux x64、Node 24.14、PROJ 9.5.1；EPSG:3857→4326，warm cache：

| 坐标数 | Core p50 | REST 全链路 p50 | 请求字节 |
| ---: | ---: | ---: | ---: |
| 1 | 0.004 ms | 1.321 ms | 66 |
| 100 | 0.102 ms | 1.264 ms | 2,921 |
| 1,000 | 1.180 ms | 2.677 ms | 28,841 |
| 10,000 | 9.774 ms | 17.347 ms | 288,041 |
| 100,000 | 114.025 ms | 194.620 ms | 2,880,041 |
| 1,000,000 | 1,279.029 ms（Core） | P0 拒绝 | 28,800,041 |

生产默认值：`MAX_POINTS=100000`、`MAX_VERTICES=100000`、
`MAX_REQUEST_BYTES=16 MiB`。完整原始结果位于 [`output/`](output/)。

## 范围边界

不提供任意 target CRS、CRS Registry/UI、垂直 datum 转换、动态 datum、geodesic
量测、geometry repair/overlay、raster warp、streaming。Geometry validity 归 Geometry
Service；米制 buffer/area/distance 归 Spatial Analysis。

## 项目结构

```text
packages/crs-contract   冻结类型与错误模型
packages/crs-core       验证、GeoJSON 遍历、统一策略
packages/crs-sdk        TypeScript HTTP SDK
adapters/proj           PROJ 原生适配与 128 项 LRU
services/crs-api        无业务状态 REST 服务
services/crs-mcp-server 受限 MCP stdio server
tests                   Golden、集成、MCP、性能
docs                    可行性、架构、验收与运维
research                证据矩阵
output                  真实 benchmark 结果
```

## 文档入口

- [`docs/01_FEASIBILITY_REPORT.md`](docs/01_FEASIBILITY_REPORT.md)
- [`docs/03_ENGINE_EVALUATION.md`](docs/03_ENGINE_EVALUATION.md)
- [`docs/04_NORMALIZATION_CONTRACT.md`](docs/04_NORMALIZATION_CONTRACT.md)
- [`docs/08_RECOMMENDED_ARCHITECTURE.md`](docs/08_RECOMMENDED_ARCHITECTURE.md)
- [`docs/09_ACCEPTANCE_REPORT.md`](docs/09_ACCEPTANCE_REPORT.md)
