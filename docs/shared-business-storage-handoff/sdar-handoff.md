# SDAR 单仓接入

状态：SDAR_RUNTIME_ADAPTATION_NOT_PERFORMED。

连接现有 GOWM database 的 ugv_sdar；应用 SQL 不再显式 public.agent_task 等，扩展仍引用实际扩展 Schema。关闭 apps/server/src/runtime.ts 的迁移应用，改为验证 GOWM install manifest。原生 schema_migration 留在 ugv_sdar，本包独立 history 不替代或污染 GOWM public.schema_migration。

设备 Task 创建必须显式 device_id、gowm_binding_id、sdar_service_key；非设备 Task 可保持 null，不能把 null 当所有设备。计划写 gowm_task_id/device_id，Workflow instance、事件和 Invocation 传同设备；事务内绑定目标修订。PLAN_NODE key 使用原生 definition_json.nodes 的 id；NODE_RUN key 包含 remote binding、instance、node、run。

remote_task_binding 写 smpp_service_key，保留 server_id 配置别名。接纳尚未发布 canonical MCP 身份时为 null；使用 resolveRemoteTask 在实际回执后验证同设备/服务。远程 Task API 仍经 MCP 调用，不用 INSERT provider_task 代替。

remote-task-repository.ts、workflow-continuation-repository.ts、任务创建/恢复入口每次传 allowedDeviceIds；所有 remote poll、cancel request、continuation、admission lease 从原生 Task/FK 链限定设备。Task revision/command authority 原生触发器完整保留，不能复制已有 Task 的非零 revision 来创建新 Task。

getTaskLineage 分别返回 lineage、targets、steps。workflow_node_event 没有可普遍证明的 Node Run 身份，因此 NATIVE_EVENT 和 REMOTE_NODE_RUN 分开返回，绝不按 nodeId 把所有重试做笛卡尔关联。计划定义仍完整返回，未派发节点不会被误称执行成功。

后续消费者不得仅改连接串就宣称多设备可用；完成设备路由、原生 Repository SQL 和清理策略适配后独立验证。旧数据迁移另行安排。

初始 Admission 另需适配 initial_task_admission：新 admission_id 为内部主键，设备幂等索引为(device_id,sdar_service_key,idempotency_key)，非设备请求保留单独局部唯一键。不能只改 Runtime 幂等而遗漏这个接纳路径。完整双设备 capability binding/attempt/admission 插入已纳入 T14_SDAR_ADMISSION_DEVICE_KEY。

订阅事件流按 device_id+smpp_service_key+provider_id 管理 current 与 generation，子 inbox/continuity 沿 subscription_id 原生 FK 继承范围。原生无 Task FK 的 external_task_projection、runtime_task_configuration_binding、临时 Skill 和 evidence 来源记录现显式保存 device_id；同事务验证已有 Task 的设备，不删除原来允许保留历史/异步来源的能力。GOWM 没有新建证据导出器。
