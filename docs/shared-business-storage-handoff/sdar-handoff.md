# SDAR 单仓接入

状态：SDAR_FIXED_STORAGE_ADAPTATION_PRESENT / CONTROLLED_API_ADAPTATION_PENDING。
2026-10-12 已只读核对相邻仓：固定共享存储、设备上下文和原生 ledger 适配已存在，部分共享身份/关联写入仍需改接 087 受控 API。具体文件与协议验收边界见 [当前分仓交接](../CAPABILITY_INTEGRATION_HANDOFF.md)。旧矩阵仍用于检查尚未接通的路径，不再表示整个运行适配未实施。

连接现有 GOWM database 的 ugv_sdar；应用 SQL 不再显式 public.agent_task 等，扩展仍引用实际扩展 Schema。关闭 apps/server/src/runtime.ts 的迁移应用，改为验证 GOWM install manifest。原生 schema_migration 留在 ugv_sdar，本包独立 history 不替代或污染 GOWM public.schema_migration。

设备 Task 创建必须显式 device_id、gowm_binding_id、sdar_service_key；非设备 Task 可保持 null，不能把 null 当所有设备。计划写 gowm_task_id/device_id，Workflow instance、事件和 Invocation 传同设备；事务内绑定目标修订。PLAN_NODE key 使用原生 definition_json.nodes 的 id；NODE_RUN key 包含 remote binding、instance、node、run。

remote_task_binding 写 smpp_service_key，保留 server_id 配置别名。接纳尚未发布 canonical MCP 身份时为 null；使用 resolveRemoteTask 在实际回执后验证同设备/服务。远程 Task API 仍经 MCP 调用，不用 INSERT provider_task 代替。

remote-task-repository.ts、workflow-continuation-repository.ts、任务创建/恢复入口每次传 allowedDeviceIds；所有 remote poll、cancel request、continuation、admission lease 从原生 Task/FK 链限定设备。Task revision/command authority 原生触发器完整保留，不能复制已有 Task 的非零 revision 来创建新 Task。

getTaskLineage 分别返回 lineage、targets、steps。workflow_node_event 没有可普遍证明的 Node Run 身份，因此 NATIVE_EVENT 和 REMOTE_NODE_RUN 分开返回，绝不按 nodeId 把所有重试做笛卡尔关联。计划定义仍完整返回，未派发节点不会被误称执行成功。

后续消费者不得仅改连接串就宣称多设备可用；完成设备路由、原生 Repository SQL 和清理策略适配后独立验证。旧数据迁移另行安排。

初始 Admission 另需适配 initial_task_admission：新 admission_id 为内部主键，设备幂等索引为(device_id,sdar_service_key,idempotency_key)，非设备请求保留单独局部唯一键。不能只改 Runtime 幂等而遗漏这个接纳路径。完整双设备 capability binding/attempt/admission 插入已纳入 T14_SDAR_ADMISSION_DEVICE_KEY。

订阅事件流按 device_id+smpp_service_key+provider_id 管理 current 与 generation，子 inbox/continuity 沿 subscription_id 原生 FK 继承范围。原生无 Task FK 的 external_task_projection、runtime_task_configuration_binding、临时 Skill 和 evidence 来源记录现显式保存 device_id；同事务验证已有 Task 的设备，不删除原来允许保留历史/异步来源的能力。GOWM 没有新建证据导出器。

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
