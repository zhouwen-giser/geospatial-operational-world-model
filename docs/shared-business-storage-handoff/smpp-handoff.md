# SMPP 单仓接入

状态：SMPP_FIXED_STORAGE_ADAPTATION_PRESENT / CONTROLLED_API_ADAPTATION_PENDING。
2026-10-12 已只读核对相邻仓：固定共享存储、设备上下文和 Mission 适配已存在，仍有直接写共享主档/关联表的路径，需要改接 087 受控 API。具体文件与协议验收边界见 [当前分仓交接](../CAPABILITY_INTEGRATION_HANDOFF.md)。旧矩阵是逐项检查表，不再表示整个运行适配未实施。

使用现有 GOWM database，连接会话 search_path=ugv_smpp,public，禁止每实例建库；启动只做 verify，不重放原生迁移。安装物已保留完整 Runtime 和 UGV family，两个 014 分别记账。

根 provider_task、admission_intent、ugv_execution 必须传 device_id、gowm_binding_id、smpp_service_key；Provider execution 的 mcp_task_id 是已验证关联列，异步时可空，不能按同名 task_id 盲 JOIN。资源、adapter URL 和 MQTT/HTTP client 上下文必须按请求设备选择；进程内 singleton/revision/cache 改成 device+source/channel 键。

按 repository-adaptation-matrix.md 替换 tasks.ts、idempotency.ts、outbox.ts、business-events.ts 的读写/冲突键/claim/recovery。runtime_lease 使用(device_id,lease_key)，owner 不是锁身份；服务全局作业继续使用稳定服务级租约机制，不能伪造设备 ID。快照必须按 device+source_session_key+channel+revision 写与读。诊断租约身份键含 device；全局 fence 序列仍保留。

Provider 保存派发回执和 execution_mission_link 使用同一个 PoolClient/事务。网络 MCP/设备调用必须在事务之外；不保证物理 exactly-once。缺 session 的 Mission 只能声明 EXECUTION_SCOPED_ID 并保存真实 execution 范围，不把 Provider epoch 等同 ingest epoch。控制关系用 CONTROLLED，不新造 Mission。

保留原生 Task handle_expires_at/expired_at 语义，停用 purge_after 对历史链的物理 DELETE。Admission、幂等、Dispatch、inbox 不得当缓存删掉。本包不提供旧库回填或运行切换；需消费者独立变更并做运行回归后上线。

runtime_lease 最终主键为(scope_key,lease_key)，scope_key 是 device_id 或 service_key 生成的带类别前缀范围。两者恰好一个非空；设备租约用 device_id，纯服务作业用稳定 service_key。旧 ON CONFLICT(lease_key) 或中间版 ON CONFLICT(device_id,lease_key) 均需替换为最终主键。owner_id 只用于持有者和 fencing，不参与 scope_key。

## 默认主档接入补充

消费端首次接入应调用 GOWM `resolveBusinessDeviceContext`，传当前 data scope 和真实服务/资源标识。
唯一启用设备只作为首次无绑定时的默认选择；结果持久化为服务绑定，之后显式携带主档 deviceId。
SDAR 可补充尚未配置的服务字段，旧绑定仍保留；多设备、跨范围和冲突不得自动选择。
详见 [设备 actor 与业务上下文接口](../UGV_DEVICE_ACTOR.md)。本仓不自动改动消费端仓库或切换服务。

## 2026-10 追加修复交接

当前核心迁移头为 093；本节记录 087–089 业务修复，001–089 与已发布 native/overlay SQL 字节冻结。后续能力和升级步骤见 [093 交付说明](../CAPABILITY_COMPLETION_2026_10.md)。
新安装默认自动安装正式 `ugv_smpp` / `ugv_sdar` 表和两个独立数据库账号，
完成主档、七条流及实际账号只读验证后启动采集。缺服务配置为 `NOT_CONFIGURED`，
`ready` 模式要求完整 SMPP/SDAR 服务身份。

业务接纳和共享关联改用基于 `SESSION_USER` 的受控函数，部署授权由管理员维护；
运行账号显式携带解析后的 deviceId，`createTarget` 也必须提供 deviceId。
SDAR canonical MCP 身份校验及 `resolveRemoteTask` 使用新 API，不能用直接读 SMPP 表绕过权限。
已有范围、密码和绑定不自动改写。其他仓库仍需独立适配，不把本地 fixture 当业务验收。

保留库只执行 `functional-repair-upgrade.js --check` / apply；不运行账号、设备初始化，
不删除卷、不恢复耗尽请求、不变更关联服务。CORE/TRACKLET/FINALIZATION/HISTORY 和
30 秒 SQL 预算、真实 gap/PROVISIONAL 以及允许少量丢包与迟到的重置策略保持。
完整配置、SSE 游标、轨迹状态和回退约束见 [本轮交接](../FUNCTIONAL_REPAIR_2026_10.md)。
