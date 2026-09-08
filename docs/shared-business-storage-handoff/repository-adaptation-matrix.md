# 后续 Repository 适配位置

本包只修改 GOWM。以下路径相对对应消费者仓库，未在消费者上应用。

|仓库 / 真实源路径|原假设|共享合同 / 必须变更|验证|
|---|---|---|---|
|SMPP `packages/database-migration-runner/src/migration-set.ts`|Runtime 两个 014 合法|GOWM 用 family+完整文件名记账，禁用消费者自动迁移|T08–T11|
|SMPP `packages/persistence-postgres/src/tasks.ts`|claim/recovery/handle purge 扫描本库|每个 claimDueCommands、schedule claim、recovery、TTL、outbox 循环 JOIN device_id 并传 allowedDeviceIds；关闭历史 purge。不能仅添加 SKIP LOCKED|T18–T21、T31|
|SMPP `packages/persistence-postgres/src/idempotency.ts`|授权+operation+key+mode+simulation|冲突键前加 device_id, smpp_service_key；保留 argument_hash 冲突、PENDING lease、stable_task_id 原有事务|T14–T15|
|SMPP `packages/persistence-postgres/src/outbox.ts`|全库出箱|写 device_id，领取和恢复按设备范围；与 admission 同事务保存|T12、T18|
|SMPP `packages/persistence-postgres/src/business-events.ts`|provider/source 单实例游标|本包事件表 PK/UNIQUE/FK 增 device_id；每个 INSERT ON CONFLICT、sequence 递增、inbox、generation JOIN 使用完整新键|T16–T17|
|SMPP `apps/ugv-provider-adapter/src/runtime.ts` 约 403–404|taskId 来自 input.taskId；externalExecutionId 用 resource+track+UUID|保留原始身份，显式写 mcp_task_id 解析结果，不假定所有上游同名 task_id 相等；每次请求 device+binding 路由|T25–T30|
|SMPP `packages/provider-adapter-kit/src/postgres-store.ts`|通用持久化|与 UGV 具体 store 的设备范围 SQL 一起适配；完整 payload/arguments 不删减|T12–T17|
|SDAR `apps/server/src/runtime.ts` / planPostV122MigrationFiles|基线+特定 01xx 增量|本包按该白名单选取；禁用重复迁移；public SQL 改为 ugv_sdar，函数 search_path 固定|T08–T11、T32|
|SDAR `packages/persistence-postgres/src/remote-task-repository.ts`|server_id,remote_task_id 来源|写 device_id/smpp_service_key；canonical_mcp_task_id 在有证据且父已发布时 resolve；未解析保持 null|T13、T25、T30|
|SDAR `packages/persistence-postgres/src/workflow-continuation-repository.ts`|Node Run / continuation 原生记录|保留 instance/node/run，不把重复 nodeId 合并；领取/恢复经 Task 设备 JOIN|T18–T19、T25|
|SDAR `packages/persistence-postgres/src/task-capability-physical-evidence-repository.ts`|admission 和 committed receipt|读取本包明确 Execution/Dispatch/Mission 关系；不通过时间或 epoch 猜合并|T26–T30|
|GOWM `packages/integrations/ugv-mqtt-ingest-core/src/mapper.ts`|现有消息会话身份|后续读 device_stream，resolveIngestDevice 唯一匹配；observer/device 不等于 observation subject|T03–T04|

所有实际安装表、列、键、来源路径见 device-scope-key-inventory.json。DEVICE_CHILD 使用已存在原生 FK 链；共享 Skill、上下文、模板和审计目录保持域级。跨设备任务不得用共享模板 ID 作为业务归属。Native evidence_export 系列表是 SDAR 运行依赖，本包没有新建导出服务或业务同步链。

新增逐项审查：SDAR initial_task_admission 的 caller idempotency 文本需要 device/service 范围（T14_SDAR_ADMISSION_DEVICE_KEY）；external_task_projection 在 repositories.ts:4554/4563/4603 实际使用本地 Task，保留原生投影而增加 device_id，不创建另一张 GOWM Task 表；runtime_task_configuration_binding、runtime_task_model_route_binding 与无硬 FK 的 evidence/temporary_skill 来源表增加显式设备列和已有 Task 一致性检查。user_goal_plan / goal / skill_goal 是可被多个设备 Task 引用的共享计划语义，不能据其当前消费者强行冻结成单车。
