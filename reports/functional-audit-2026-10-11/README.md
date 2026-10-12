# GOWM 功能落实检查（2026-10-11）

检查对象是本地提交 `506315b5a60e5f5fe405f020f61cec24be0be47d`，正式迁移头为 086。正式 World Platform registry 注册 16 个 Provider、124 个 operation：31 Stable、91 Preview、2 Experimental。成熟度不能替代端到端运行证据。

结论：核心功能已有实质代码和正式存储实现，仍存在默认部署、业务账号、服务绑定及旧轨迹分析的实际缺口。部分更高层历史能力和跨仓运行接入也尚未在本仓形成完整交付证据。

此次检查没有连接 sz-gowm，也没有检查其他仓库的最新代码或修改运行服务。复现仅使用两个任务独占的临时 PostgreSQL；临时容器及其卷已清理。未重跑以前的大规模性能、现场恢复和 SACS→WSGS 验收。

## 一、应优先修正的实际问题

### F01 / P1：默认 UGV 初始化与 Gateway、H3 态势范围配置冲突

- 正式迁移创建 `default` 范围；`.env.example` 的 Gateway 范围为 `default`，UGV 范围却为 `airport-sim-ugv-01`。
- 按默认配置初始化设备，会实际产生两个范围。H3 态势 Repository 明确要求数据库只存在一个范围，因此默认初始化前 readiness 为 true，初始化后为 false，原因是 `GOWM Situation provider requires a verifiable single-scope deployment`。
- UGV 数据也不属于默认 Gateway principal 的 `default` 范围。经默认 Gateway 的受限查询无法访问这些 UGV 数据。已有现场如果显式复用同一范围，可以不触发此问题；本次未判断现场配置。
- 这是跨组件默认值不自洽。需要部署前校验、按实际授权配置统一数据范围；要支持多个范围，还需要正式改造态势投影及读取合同。不能通过简单删除单范围检查让未隔离的聚合继续提供结果。

证据：[环境模板](/home/zhouwen/web-download/geospatial-operational-world-model/.env.example:101)、[Gateway 默认范围](/home/zhouwen/web-download/geospatial-operational-world-model/.env.example:163)、[态势范围检查](/home/zhouwen/web-download/geospatial-operational-world-model/services/providers/gowm-situation-provider/src/repository-adapter.ts:104)、[真实 PostgreSQL 结果](/home/zhouwen/web-download/geospatial-operational-world-model/reports/functional-audit-2026-10-11/default-scope-postgres.json)。

### F02 / P1：初始业务账号无法使用默认设备上下文接纳入口

- 初始化账号只获得各自 `ugv_smpp` / `ugv_sdar` 的 DML 和 `gowm_device_reader`。
- `resolveBusinessDeviceContext()` 默认使用 `admit`，会对 `device_service_binding` 执行 `SELECT ... FOR UPDATE`，并在首次接入或补充 SDAR 配置时写绑定。
- 使用实际生成的两个业务账号，首次调用均复现 SQLSTATE `42501`。管理员预建绑定后，`verify` 可成功，默认 `admit` 仍因 `FOR UPDATE` 报权限错误。
- 两账号同时缺少 `gowm_task`、`gowm_execution`、`gowm_business_v1` 的 schema USAGE，因此目标、执行关联及统一查询 SDK 的权限交付也未完整接通。
- 现有集成测试将“账号可写自己的 schema”与“默认设备解析”分别测试，后者用管理员连接，未覆盖这个组合。

需要明确部署管理员预绑定与运行时只读的合同，或提供受控的最小权限接纳/关联函数；按计划要求保留首次默认关联时，应让它能在正式业务账号下完成。补充两个真实登录账号的完整接入测试。

证据：[账号授权](/home/zhouwen/web-download/geospatial-operational-world-model/scripts/business-storage/accounts.ts:44)、[只读角色](/home/zhouwen/web-download/geospatial-operational-world-model/database/migrations/079_device_context_reader.sql:7)、[解析入口](/home/zhouwen/web-download/geospatial-operational-world-model/packages/integrations/device-business-storage/src/context.ts:89)、[测试连接](/home/zhouwen/web-download/geospatial-operational-world-model/tests/integration/ugv-device-actor.integration.test.ts:101)、[真实权限复现](/home/zhouwen/web-download/geospatial-operational-world-model/reports/functional-audit-2026-10-11/business-role-postgres.json)。

### F03 / P1：自动初始化没有转发可选服务绑定配置

`device-cli.ts` 支持 `SMPP_SERVICE_KEY`、`UGV_PROVIDER_ID`、`UGV_RESOURCE_ID`、`SDAR_SERVICE_KEY`、`SDAR_MCP_SERVER_ID`、`SDAR_AGENT_PROFILE_ID`，但 Compose 的 `ugv-device-init.environment` 六项均未声明，规范环境模板也没有提供它们。

因此，沿标准 Compose 安装入口，即使用户在主机 `.env` 中填写这些字段，容器也不会收到；没有 `input.business` 时初始化与验证都不会要求服务绑定存在。设备和七条流可以显示 PASS，而业务服务绑定依旧为空。手工以正确环境调用 CLI 可以建立绑定，缺口发生在自动部署接线。

需要转发配置、验证参数完整性，并在声明需要业务接入时将绑定验证纳入安装门禁。

证据：[Compose 初始化服务](/home/zhouwen/web-download/geospatial-operational-world-model/docker-compose.yml:148)、[CLI 可选参数](/home/zhouwen/web-download/geospatial-operational-world-model/scripts/business-storage/device-cli.ts:12)、[条件初始化](/home/zhouwen/web-download/geospatial-operational-world-model/packages/integrations/device-business-storage/src/bootstrap.ts:76)、[实际 Compose 解析](/home/zhouwen/web-download/geospatial-operational-world-model/reports/functional-audit-2026-10-11/compose-bootstrap-wiring.json)。

### F04 / P1：旧轨迹 REST/MCP 分析仍会跨观测缺口推断停留和累计距离

新版历史 Provider / STAS 有片段、缺口和冻结语义；旧 `/trajectory/:entityId/track`、`/stops` 仍从 `trajectory_point` 取平铺点数组，直接调用旧 analytics。MCP `get_object_track` 继续调用该旧 REST 路径。

最小复现：同一位置只有 00:00 和 01:00 两条记录，中间无观测，`detectStops()` 返回持续 3,600,000ms 的停留。将后一位置移动约 85km，`distanceTraveledM()` 会把这段无连续证据区间直接累计进“行驶距离”。这些函数没有接收片段/会话/缺口上下文。

需要让旧入口使用同一缺口感知的分析基础，明确不确定区间和截断；不能只修新历史 Provider 而继续让旧 Agent 工具给出更强结论。

证据：[平铺读取](/home/zhouwen/web-download/geospatial-operational-world-model/packages/runtime/src/trajectory-repository.ts:18)、[REST 分析调用](/home/zhouwen/web-download/geospatial-operational-world-model/services/world-api/src/app.ts:356)、[旧分析](/home/zhouwen/web-download/geospatial-operational-world-model/packages/trajectory-model/src/analytics.ts:12)、[MCP 调用](/home/zhouwen/web-download/geospatial-operational-world-model/services/world-mcp-server/src/server.ts:110)、[复现结果](/home/zhouwen/web-download/geospatial-operational-world-model/reports/functional-audit-2026-10-11/legacy-trajectory-probe.json)。

### F05 / P2：SSE 的大量积压补偿与标准断线续传尚未完成

`/events/stream` 已实现订阅期间缓冲、去重和一次数据库回放，但回放固定只读前 10,000 条，随后直接切换实时消息，没有分页循环或截断信号，也未处理 `Last-Event-ID`。

代码路径表明：若连接前已有超过 10,000 条符合游标条件、且已经发布过的事件，超出的部分不会由这次数据库回放返回，也不会再次进入实时订阅。调用者可以用 `sinceWorldVersion` 主动发起查询，但当前服务未提供标准事件 ID 恢复及同版本多事件的稳定分页游标。

需要稳定游标分页、订阅与回放交接、断线恢复及明确预算/背压处理。此项为代码路径检查，未开展大规模 SSE 运行测试。

证据：[单次回放](/home/zhouwen/web-download/geospatial-operational-world-model/services/world-api/src/app.ts:327)、[事件排序和 LIMIT](/home/zhouwen/web-download/geospatial-operational-world-model/packages/runtime/src/event-repository.ts:28)。

## 二、已有实现，但产品链路或部署自动化仍有限

### C01：原生业务表安装没有纳入默认部署就绪流程

正式安装器及原生 SQL 已存在，不应把它描述成“只有空库设计”。但 `dev-deploy.sh up` / Compose 自动链路只执行核心迁移、账号初始化及设备初始化，没有调用 `business-storage/cli.js install --domain all`。

隔离库完成相同数据库步骤后，`ugv_smpp.provider_task` 和 `ugv_sdar.agent_task` 均不存在。原生安装仍需管理员显式执行，SDAR 还要求预先安装 `public.vector`。这是现有文档明确保留的人工步骤；部署包可用不等于业务存储已就绪。

如要承诺“一次安装后业务可接入”，需要受控的原生安装步骤、依赖检查及 `verify` 门禁。不要用账号/设备初始化成功代替业务表验证。

证据：[部署指南人工步骤](/home/zhouwen/web-download/geospatial-operational-world-model/docs/DEV_DEPLOYMENT.md:162)、[vector 前置检查](/home/zhouwen/web-download/geospatial-operational-world-model/scripts/business-storage/installer.ts:46)、[初始化后的表检查](/home/zhouwen/web-download/geospatial-operational-world-model/reports/functional-audit-2026-10-11/business-role-postgres.json)。

### C02：Task—目标—Execution—Mission 的真实跨仓运行闭环尚未在本仓证明

公共表、原生表适配、设备约束、Typed Repository、只读查询视图和双设备 fixture 已实现。`registerMissionIdentity()`、`linkExecutionToMission()` 和 lineage 查询有实际代码。

当前 GOWM 服务中没有调用这些 Mission 关联写入方法；调用证据主要在存储 fixture。SMPP/SDAR 交接文档仍标注 `*_RUNTIME_ADAPTATION_NOT_PERFORMED`，要求消费者修改 SQL、幂等键、claim/recovery、设备路由和回执写入。

这说明 GOWM 存储交付不能单独证明真实业务全链路已经接通。本次未检查外仓最新实现，因此不能据此断言它们当前仍未适配。后续需各仓给出真实两设备业务请求、目标及派发回执、Mission 关联和统一查询验收证据。

原任务明确将额外 HTTP SQL 网关、MCP 数据库工具和管理 UI 排除在范围外；这些入口的缺失不列为该存储任务的实现缺陷。

证据：[Mission/lineage 实现](/home/zhouwen/web-download/geospatial-operational-world-model/packages/integrations/device-business-storage/src/repository.ts:109)、[SMPP 交接](/home/zhouwen/web-download/geospatial-operational-world-model/docs/shared-business-storage-handoff/smpp-handoff.md:3)、[SDAR 交接](/home/zhouwen/web-download/geospatial-operational-world-model/docs/shared-business-storage-handoff/sdar-handoff.md:3)。

### C03：完整历史轨迹 Artifact 与高级历史推理未交付

`history.get-trajectory` 有正式物化、引用、缺口、完整性和有界预览，但没有按范围校验的完整轨迹 Artifact 读取闭环。超出预览预算时会返回 `history.artifactDeferred=true`，消费者不能通过此公开操作取得全部轨迹节点。

道路匹配、历史时空事件、最后交汇、历史信号/指标排名也在当前消费者合同的显式非声明列表中。基础空间查询、围栏事件、STAS 工具和轨迹重建已经存在，不能用它们替代上述更高层操作的实现和验收。

证据：[预览与延期标记](/home/zhouwen/web-download/geospatial-operational-world-model/services/providers/historical-trace-provider/src/repository.ts:243)、[消费者明确非声明](/home/zhouwen/web-download/geospatial-operational-world-model/contracts/gowm-v0.7.1/wsgs-historical-consumer-lock.schema.json:147)。

### C04：设备时间与重置策略只完成当前代理时间模型

UGV 观测的事件时间估计、任务事件时间均使用 MQTT 适配器接收时间；来源时间只保留为原始值，并标记 `SOURCE_TIME_TICKS_UNRESOLVED`。当前并没有把仿真 tick / 设备时钟转换成可靠事件时间。

因此消息积压后成批到达、设备重置或网络抖动可能影响速度和连续性判定。这是代码所支持的风险机制，不是本次对某条服务器缺口根因的确认。

重置 COMPLETE 策略只接受 `mqtt-arrival-proxy-v1 / ADAPTER_WALL_CLOCK`；其他时钟记录 `TIME_MODEL_UNSUPPORTED`。随包说明还保留了仿真 UI `/api/reset` 不发布 reset_ack 的接入缺口，本次未检查仿真仓库新版本。新会话建立仍由既有显式流程管理。

证据：[观测时间模型](/home/zhouwen/web-download/geospatial-operational-world-model/packages/integrations/ugv-mqtt-ingest-core/src/mapper.ts:74)、[事件时间](/home/zhouwen/web-download/geospatial-operational-world-model/packages/integrations/ugv-mqtt-ingest-core/src/mapper.ts:393)、[水位时钟限制](/home/zhouwen/web-download/geospatial-operational-world-model/database/migrations/083_reset_ack_watermarks.sql:103)、[随包重置说明](/home/zhouwen/web-download/geospatial-operational-world-model/docs/HISTORY_RESET_WATERMARKS.md)。

### C05：采集配置尚未成为通用设备接入和在线启停控制面

当前 UGV adapter 限定 `SIMULATION` 和 EPSG:32648；订阅固定七个业务主题及 reset_ack，QoS 固定为 1。启动时要求七个主题都有可用 stream，随后设备及路由上下文冻结到会话。

因此数据库中的 `message_profile`、`mapper_config`、`qos` 等字段尚不能普遍驱动运行时订阅；也没有单条流在线停启/换端点管理流程。双设备需要独立采集会话，缺少通用的设备连接编排入口。

会话身份冻结本身符合已确认计划，应保留。未来配置切换需建立新会话，不能改写旧消息归属。若产品定位继续限定当前机场仿真适配器，这属于扩展边界；不能宣称通用实车、多车型接入已经完成。

证据：[适配器范围](/home/zhouwen/web-download/geospatial-operational-world-model/services/ugv-mqtt-ingest/src/config.ts:60)、[冻结配置](/home/zhouwen/web-download/geospatial-operational-world-model/services/ugv-mqtt-ingest/src/app.ts:35)、[固定订阅](/home/zhouwen/web-download/geospatial-operational-world-model/services/ugv-mqtt-ingest/src/app.ts:225)、[七条流检查](/home/zhouwen/web-download/geospatial-operational-world-model/packages/integrations/device-business-storage/src/context.ts:70)。

## 三、生产化与持续验证的缺口

- **直接入口的身份和授权边界：** Gateway 已实现受控身份、单范围 principal 及可选签名委托；但 World API、Observation API、MCP HTTP 等旧入口仍依赖可信网络，没有同等的客户端认证/范围授权。Observation 的 operational-event 入口仅比较客户端提供的 header 与 body scope。开发 overlay 默认暴露 `0.0.0.0`，Mosquitto 配置允许匿名。现有交付明确是受信 LAN/VPN 拓扑；正式公网/多租户接入仍需落实端到端身份、权限与 TLS/ACL。参见 [Observation 接口](/home/zhouwen/web-download/geospatial-operational-world-model/services/observation-ingest/src/app.ts:89)、[MCP HTTP](/home/zhouwen/web-download/geospatial-operational-world-model/services/world-mcp-server/src/index.ts:13)、[MQTT 配置](/home/zhouwen/web-download/geospatial-operational-world-model/infrastructure/mosquitto/mosquitto.conf:1)。
- **持续验证未覆盖关键组合：** bootstrap 静态脚本主要检查文件和字符串；环境审计未覆盖 `scripts/business-storage/device-cli.ts` 的动态变量名。当前 CI 没有显式执行带 `GOWM_ACTOR_TEST_DATABASE_URL` 的真实业务账号/设备接入组合，现有集成用管理员测试默认绑定。迁移冻结锁固定 001–068，未增加 069–084 独立历史字节锁；84→86 测试验证本次升级前后的账本一致，无法单独证明其 084 输入与过去已发布包一致。没有发现旧迁移已被改写；缺口在自动防护。参见 [bootstrap 静态检查](/home/zhouwen/web-download/geospatial-operational-world-model/scripts/verify-ugv-bootstrap-package.mjs:18)、[环境审计范围](/home/zhouwen/web-download/geospatial-operational-world-model/scripts/validate-deployment-env.mjs:73)、[CI](/home/zhouwen/web-download/geospatial-operational-world-model/.github/workflows/gowm-v071-exact-head-qualification.yml:59)、[冻结范围](/home/zhouwen/web-download/geospatial-operational-world-model/scripts/verify-v071-migration-freeze.mjs:13)。
- **长期运维尚未形成部署交付：** 已有诊断、脱敏阶段日志和 MQTT metrics，仍缺少随部署交付的备份/WAL 归档调度、PITR/HA 实测、容量/分区保留策略及完整告警看板。运维手册明确只有备份恢复操作说明，不声明完成生产恢复演练。不可变历史数据的长期增长需要实际容量方案。参见 [恢复边界](/home/zhouwen/web-download/geospatial-operational-world-model/docs/18_OPERATIONS_RUNBOOK.md:119)。
- **状态文档滞后：** `PROJECT_STATUS.md` 仍标注 2026-08-31，迁移概述停在 069；部分重置文档还描述旧 LIVE/HISTORY 双循环。当前代码已经是 CORE/TRACKLET/FINALIZATION/HISTORY。需要以当前交付状态更新索引，避免把旧文档的完成或延期结论套用于新版本。

## 四、已核实的实质实现及检查边界

以下内容不列为“只有设计”：默认主档及七条流的事务初始化、新版事件 actor 的主档解析及持久会话冻结、083 回执处理和追加水位、085 合并调度及租约、独立重建/封存/历史请求执行槽、086 请求评估证明及受控旧轨迹复用、正式共享业务安装器/SQL/设备约束/Typed Repository。

本轮通过：根 TypeScript no-emit、bootstrap 静态检查、环境模板检查、版本一致性、001–068 冻结检查及隔离 PostgreSQL 全量 001–086 迁移。现有部署包 SHA-256 为 `62fd9970d399039df7c7c138e8534f73c294e33836f629f64e56da3a4a91eb81`，其中历史交付清单的 108 个源码/迁移/说明摘要与当前本地代码一致。

这些静态检查通过，同时 F01–F04 可以出现，说明需要补跨组件和正式登录账号的验收。未重新确认当前现场的积压、SLO、历史 Finding、其他仓库接入或生产容量，也未用旧验收报告替代这些确认。

建议顺序：先修 F01–F03 使默认部署与正式账号可接入；再修 F04–F05 保证旧查询及事件交付的语义；随后补原生业务库就绪和跨仓真实验收。完整轨迹 Artifact、时钟接入及高级历史分析按产品优先级独立交付。

总证据：[audit-evidence.json](/home/zhouwen/web-download/geospatial-operational-world-model/reports/functional-audit-2026-10-11/audit-evidence.json)。
