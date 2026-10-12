# 后续能力的分仓接入

2026-10-12 只读核对本地最新工作树。HEAD 与被检查文件摘要保存在源码报告 `reports/capability-completion-2026-10-12/adjacent-source-audit.json`，未修改相邻仓，未把本地代码视为当前服务器状态。

## SMPP / SDAR

SMPP（sdar-mcp-provider-platform，c64897a）已经有固定共享 schema 适配和设备解析：`packages/gowm-shared-storage-adapter/src/device-context.ts`、`target-links.ts`、`native-missions.ts`、`mission-links.ts`。不能继续笼统标为“没有运行时适配”。但这些当前路径仍直接读写 GOWM 主档/目标/Mission 表，未使用 087 的受控业务 API。

SDAR（skill-driven-agent-runtime，ffc65b64）已有 `packages/persistence-postgres/src/gowm-storage-contract.ts`、`gowm-device-context.ts`、`gowm-targets.ts`，使用固定 `ugv_sdar` 和 native 账本。所检查路径同样没有接到新受控 API。严格 ledger/结构检查必须识别 `GOWM_API/business_api_v2.sql`，不能把新增正式 overlay 当成未知漂移。

后续获授权的分仓任务应替换以下接口，不为兼容直接 SQL 而扩大 GOWM 运行账号权限：

| 现有接线 | GOWM 接入合同 |
| --- | --- |
| 自行扫描主档、猜测唯一设备、直接创建服务绑定 | 在业务事务里 `resolveBusinessDeviceContext(client, input, 'admit')`；已有绑定或显式设备优先；新默认仅当前范围唯一启用主档；绑定持久化；仅核验用 `'verify'` |
| 直接 INSERT target_geometry / target_binding | `BusinessStorage.createTarget`（显式 deviceId）及 `attachTargetToOwner`；target/owner/domain/service 由 SESSION_USER 授权校验 |
| 直接 INSERT/UPDATE mission_identity / execution_mission_link | `registerMissionIdentity` / `linkExecutionToMission`；不能把协议失败或未解析回执写成成功关联 |
| 以当前主档版本自行拼 actor | 直接使用解析结果中的 actorReferenceKey；外部标识、主档 deviceId 和 wrf 引用分开 |
| 跨设备统一列表、MCP/目标/轨迹 lineage 查询 | SDK `listDeviceTasks/getTaskLineage/getMissionLineage/getTaskTargets/getMcpTaskDetails`，所有入口带真实 deviceId |

SDK 位于本仓 `packages/integrations/device-business-storage`；底层受控入口为 `gowm_business_api.resolve_device / write / read`，具体参数以该 SDK 和正式 087 SQL 为准。共享业务表仍只使用 `ugv_smpp`、`ugv_sdar`；SMPP/SDAR 的自身业务表写入必须显式携带解析出的 device_id。没有数据库全局默认设备、实例级业务库、business_store 或导出同步链。

部署管理员沿用既有账号/密码和 `authorizeBusinessServices` 授权。运行账号不能自行授权、改绑定、扩充设备列表或获得所有者角色。两个实际登录账号的 GOWM 双设备 fixture 已验证，不代表外仓正常 MCP 派发和回执链已完成。

分仓验收必须走正常协议完成两个独立设备的 Task → Target → MCP Task → Execution → Mission → 查询；覆盖重复回执、失败、无绑定/歧义和重启恢复。不能通过直接插表制造派发成功。此前耗尽的请求保持原状。

## 高级历史 Provider

gowm-spatiotemporal-analysis-providers（53dc6e1）已经有三个真实服务：
`map-matching-provider`、`temporal-events-provider`（temporal-spatial.find-events）和
`metric-ranking-provider`（spatiotemporal-metric.rank-locations）。本轮没有在 GOWM 重做这些算法。

当前 `packages/gowm-read-adapter/src/index.ts / read-execution.ts` 已读取：

- `gowm_history_v2.read_trajectory_samples(text,integer,timestamptz,integer,jsonb)` 的有界样本及采样证明；
- `gowm_history_v1.historical_trajectory_revision_as_of` 与精确 revision 的 segment、gap、excluded period。

这些已存在读合同保留，消费者无需为本次升级被迫改为 Artifact。需要完整几何时，可以独立接入 `history.open/read-trajectory-artifact@1.0` 和新消费锁。必须传播 gap、PROVISIONAL/封存状态、精确请求评估、道路/规则/信号版本和不确定度。Artifact READY 不能使道路匹配、最后交汇或指标排名自动获得业务资格。

目前 GOWM 公开 registry 增加的是完整轨迹的两项能力，不将外仓未做本轮真实链路验证的算法标成 GOWM STABLE。正常 SACS→WSGS 的 Finding 验收、现场规模/SLO 和每项高级分析声明仍需相应分仓任务提供证据。

## 仿真回执

本地 isr-simulation c106205 的 `_reset_cmd_cb` 发布 `/sim/reset_ack`，bridge 为 QoS 1。UI `/api/reset` 只调用 reset_simulation，仍没有该回执。仿真仓后续应统一实际成功/失败结果出口，避免只给 MQTT 指令回执；不得由 GOWM 伪造 UI 成功回执或猜测新会话身份。

本轮校准锚点仅用于测试。提供真实 tick/UTC 对照证据、校准来源、漂移界限及会话标识后，管理员才能注册真实运行 profile。缺少证据时继续显式 ARRIVAL_PROXY/unresolved，不提高速度阈值掩盖轨迹缺口。
