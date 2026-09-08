# UGV 设备主档与事件 actor

从 mapper `ugv-mqtt-canonical-v3` 起，新采集会话必须读取正式设备主档和采集配置。
`/ugv/mission_state`、`/ugv/area_recon/status` 的状态转换和控制应答事件均带一条
`actorReferenceKeys`，指向本车主档关联的 `WORLD_OBJECT`。目标引用不因此自动补齐。

## 初始化与检查

在 GOWM 现有数据库执行核心迁移及共享业务安装，不创建业务数据库：

```bash
npm run db:migrate
node dist/scripts/business-storage/cli.js install --domain all
node dist/scripts/business-storage/device-cli.js init-default
node dist/scripts/business-storage/device-cli.js verify-default
```

源代码环境的后两条命令对应 `npm run device:init-default` 和 `npm run device:verify-default`。
核心迁移使用现有 `DATABASE_URL`，存储和设备 CLI 必须显式提供 `GOWM_DATABASE_URL`。
`init-default` 是管理员操作；`verify-default` 使用只读事务。两者均不连接 MQTT，
不派发指令、不写业务任务或模拟观测。安装器同时安装迁移 078 和 079；079 仅增加读取角色授权。

初始化复用以下实际部署配置：

| 环境变量 | 默认值或含义 |
| --- | --- |
| `UGV_DATA_SCOPE_KEY` | `airport-sim-ugv-01` |
| `UGV_DEVICE_NAMESPACE` | `ugv` |
| `UGV_DEVICE_ID` | 外部设备标识，默认 `ugv`，不是主档 ID |
| `GOWM_DEVICE_ID` | 初始化时可显式指定已有主档/世界对象 ID；否则复用匹配主档，首次创建使用 `ugv:<外部标识>` |
| `UGV_DEVICE_NAME` | 首次创建名称，默认 `UGV`；重复初始化保留已有名称 |
| `UGV_SOURCE_KEY` | `ugv-airport-sim-mqtt` |
| `UGV_PRODUCER_PIPELINE_KEY` | `ugv-airport-sim-mqtt:canonical-v1` |
| `UGV_ANALYSIS_SPACE_KEY` / `UGV_ANALYSIS_SRID` | `airport-utm48n` / `32648` |
| `UGV_MQTT_ENDPOINT_KEY` | `ugv-default`；采集进程必须使用相同值 |
| `UGV_MQTT_URL` | 必填实际 broker URL，禁止嵌入账号密码 |
| `UGV_MQTT_CLIENT_ID_PREFIX` | 初始化默认 `gowm-ugv-ingest`；完整进程 client ID 仍由 `UGV_MQTT_CLIENT_ID` 指定且必须唯一 |
| `UGV_MQTT_CREDENTIAL_REF` | 可选凭据管理引用，不存凭据；运行时仍使用既有用户名及凭据文件配置 |

初始化在同一事务内注册来源、pipeline、七条 datastream、主档、endpoint 和七条
`BOUND_DEVICE` stream；若同名 datastream 已属于其他来源，使用 `<sourceKey>:<datastreamKey>`。
新映射器使用实际注册的 datastream key。重复执行不会增加主档或覆盖冲突配置；
不同范围的世界对象、已禁用设备、被删除对象、冲突 endpoint、stream 或服务绑定均报错并回滚。

可在同一次初始化中提供真实服务配置：`SMPP_SERVICE_KEY`、`UGV_PROVIDER_ID`、
`UGV_RESOURCE_ID`，以及可选成对的 `SDAR_SERVICE_KEY`、`SDAR_MCP_SERVER_ID` 和
`SDAR_AGENT_PROFILE_ID`。不提供服务参数时只初始化设备采集链；不会猜测外部服务 ID。
后续消费者首次接入使用下节接口完成关联。

管理员向采集数据库登录角色授予 `gowm_device_reader`（`GRANT gowm_device_reader TO <实际采集角色>`）。
此角色仅允许读取主档、来源关联、endpoint、stream 和世界对象引用；不赋予设备配置写权限。
原有 `ugv_ingest` inbox/outbox 权限独立保留。该读取角色并非跨租户认证机制，部署方仍负责连接与范围授权。

## SMPP / SDAR 默认设备上下文

GOWM 导出 `resolveBusinessDeviceContext(client, input, mode?)`，调用方管理同一个 PostgreSQL
事务。`input` 包含 `scope`、可选主档 `deviceId`、`smppServiceKey`、`providerId`、`resourceId`，
以及可选 SDAR 服务字段。返回 `deviceId`、`deviceIdentifier`、`dataScopeKey`、
`actorReferenceKey`、`bindingId`、`smppServiceKey`。

- 显式设备必须与已有服务资源绑定一致。没有显式设备时，先按当前服务资源绑定解析。
- 首次未绑定时，只能默认关联当前范围内唯一启用主档；没有设备或有多台设备均报错。
- 默认 `admit` 模式持久化首次关联。后续 SDAR 可补充尚未配置的服务字段：关闭旧绑定并建立新绑定，保留历史引用；已有不同值不能覆盖。
- `verify` 模式只读取和校验，缺少或不完整的绑定报错，可用于消费者只读启动检查。
- 返回的主档 `deviceId` 必须显式用于共享 `ugv_smpp` / `ugv_sdar` 的设备范围读写。
  不增加 SQL 全局默认设备，不允许随机取第一条记录。

本次只提供 GOWM 接口及接入约定。SMPP/SDAR 仓库的消费端修改和运行切换仍需各仓完成。

## 会话与升级

一次 MQTT 采集会话只对应一台主档设备；双设备使用独立的会话/client ID及可明确区分的
endpoint 或身份路由。初始化默认的固定七主题在同一 endpoint 上不能跨设备绑定重叠。
`TOPIC` / `PAYLOAD` 配置通过现有路由接口登记，实际每条消息均由 `resolveIngestDevice()`
解析；NO_MATCH、AMBIGUOUS、其他设备命中均失败，不回退默认设备。

会话在 `mapper_context` 中冻结主档 ID、外部标识、actor 引用版本、endpoint 和 routes，
一并计算哈希。新会话严格验证主档启用、范围、世界对象引用和采集来源；映射旧消息不重新
查主档。重连保持已冻结的 actor 版本，其他配置变更仍受现有会话冲突检查保护。
世界对象版本变化不影响按 actor 身份查询，事件中的原始引用版本保持不变。
`ugv_ingest.device_id` 仍保留既有外部标识语义；业务表使用主档 ID，两者不能互换。

升级步骤：

1. 保持旧消费者处理旧流量，安排停发/停订阅边界，排空旧 inbox/outbox，检查失败项。
2. 完成迁移、默认初始化及 `verify-default`，为采集账号授权读取角色。
3. 明确结束旧 broker 持久会话，使用新的唯一 client ID 和新版代码建立会话；不要删除旧 GOWM 会话、inbox/outbox 或事件。
4. 确认七主题订阅就绪，检查新事件 actor，并按主档引用查询对应任务。变更后回滚需先排空新版会话，再停止新版并切回旧消费者；不得让旧代码处理 v3 上下文。

v1/v2 持久消息继续按旧规则处理，已入库 actor 为空的历史事件不回填；已有待处理消息
会阻止上下文不兼容的切换。新版本缺少主档上下文时禁止继续以空 actor 运行。

## 验证

`npm run validate:ugv-device-actor` 要求 `GOWM_ACTOR_TEST_DATABASE_URL` 指向已迁移的
`gowm_ugv_actor_test` 或 `gowm_ugv_actor_test_*` 隔离数据库，避免把跳过集成测试当作成功。
测试覆盖重复初始化、现有对象复用、双设备、服务默认关联、只读角色、引用查询、
不合法设备、会话冻结、重投幂等和旧事件不变。测试不连接运行中的 broker。

## 安装时自动初始化（2026-09-08）

新部署包默认启用 `UGV_MQTT_INGEST_ENABLED=true`，自带来源锁定的
`config/ugv-source-schema`。先运行 `bash scripts/dev-deploy.sh init`，在生成的
`.env` 中配置实际 `UGV_MQTT_URL`，再运行 `bash scripts/dev-deploy.sh up`。
无需再手动执行设备初始化命令。部署入口会检查 broker 地址和来源文件，
不能用占位地址启动；旧环境显式关闭采集的设置保持不变，需要启用时设为 true。

Compose 自动顺序：

1. `migrate` 应用正式迁移。
2. `business-accounts-init` 创建/检查 `ugv_smpp_app`、`ugv_sdar_app` 数据库登录角色。
3. `ugv-device-init` 依次执行 `init-default` 和 `verify-default`。
4. 两条命令都成功后，`ugv-mqtt-ingest` 启动并订阅 7 个固定 MQTT 主题；就绪检查要求订阅成功。

初始化复用已有主档、世界对象、范围、来源及 pipeline。已有范围的 TEST/SIMULATION
分类和来源默认分析空间保持不变；只核对来源所属范围以及显式采集分析空间的 SRID。
缺少主档时才登记主档；缺少世界对象时才创建。重复执行不新增设备、不改名、不覆盖
禁用/冲突的端点和采集流。跨范围、身份、broker、绑定及 datastream 冲突使安装失败。
使用 `GOWM_DEVICE_ID` 可明确选择既有世界对象；未设置时优先采用已匹配主档，首次默认
世界对象 ID 为 `ugv:${UGV_DEVICE_ID}`。实际外部设备标识与主档 ID 仍分开处理。

`init` 为两个数据库账号生成独立随机密码，保存于 `.env` 和
`.runtime/dev-deploy/business-connections.env`（权限 0600，目录 0700）。文件包含账号、
密码、固定 schema 和 Compose 网络连接 URL；外部分仓使用时把 `postgres:5432`
替换为实际数据库主机及发布端口。重复安装保留密码，账号已有且密码不一致时明确失败，
不会自动重置。直接用 Compose 前也必须先执行 `init`，或提供两个合法且不同的密码。

账号仅获得各自固定 schema 的 DML、序列权限及设备配置读取角色，不创建实例库，
不设置全局默认 device_id。缺失的共享 schema 会创建为空；账号初始化不等于
SMPP/SDAR 原生表迁移已安装。原生业务表仍由既有 `business-storage/cli.js install`
管理，SDAR 仍要求管理员提供 public.vector 扩展。未来由同一安装角色创建的表自动
继承域内授权；若变更迁移管理员，安装完成后重新执行账号初始化以授权既有表。
真实 service key 未配置时不会生成虚构业务服务绑定；消费者通过统一上下文解析入口
持久化绑定并显式传入 device_id。

本流程不清空数据、不回填旧事件、不重置 MQTT 持久会话。v2 → v3 的在用持久会话仍须
按前文先排空旧 inbox/outbox 再切换；该一次性升级操作不能混入每次启动的初始化。
