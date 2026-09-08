# G04 — 共享业务库的设备范围、键和并发

这是功能正确性工作，不是新安全平台。目标是两台设备真正共用同一套表，不串任务、快照或幂等结果。

## A. 根记录与设备归属

ugv_smpp.provider_task：
- device_id：托管UGV设备任务必须明确填写，无默认ugv1。
- gowm_binding_id：冻结当时绑定。
- smpp_service_key：需要保留逻辑来源范围时写入；不能用process ID。
- 建立(device_id,task_id)可引用唯一键，设备/绑定一致性FK。
- task_id沿用当前全局唯一UUID；不因设备变化换ID。

ugv_smpp.ugv_execution：
- device_id、gowm_binding_id、稳定provider来源键（若当前字段不足）。
- 保留原task_id/外部execution identity；明确它与MCP Task的真实对应，不凭同名列JOIN。
- 对设备本地external_execution_id重设为(device_id,稳定来源,external_execution_id)唯一；若源生成器已保证全局唯一，记录证据并保留主键，但源本地别名仍需设备范围。

ugv_sdar.agent_task：
- device_id、gowm_binding_id、sdar_service_key（稳定逻辑来源）。
- 非设备Task可为空，设备业务Repository必须拒绝漏传device_id；不得用进程配置自动补成ugv1。
- 公共设备查询只返回明确设备记录，NULL不等于所有设备。

ugv_sdar.remote_task_binding：
- 明确device_id（或通过强父级关系确定）、smpp_service_key、可验证的canonical MCP Task身份。
- 删除旧smpp_store_id方案。
- server_id是外部/配置别名，不能单独当成全局Runtime身份。
- 异步接纳时上游/下游记录可能尚未全部存在：显式未解析，不制造ID或硬加不可能满足的提前外键。

## B. 每张表必须归入一种范围

source-inventory中的每个表：
- DEVICE_ROOT：直接device_id。
- DEVICE_CHILD：由明确FK父级确定；独立领取/读取需要时加device_id。
- DEVICE_CHANNEL：快照、游标等以device_id+source/channel/session定位。
- BUSINESS_GLOBAL：公共Skill、operation定义、固定库安装记录等。
- WORKER_EPHEMERAL：owner/lease等处理者信息，不是业务归属。

全局表不得强行绑定ugv1；设备专属表不得省略范围。没有理由的UNKNOWN分类不得进入完成报告。

## C. Idempotency

核查admission、idempotency record/claim、response inbox及创建调用所有唯一键。
设备操作的幂等空间至少包含：
device_id + 稳定操作来源/Provider范围 + 原有调用者授权范围 + operation + idempotency_key + execution mode。
不同设备同文本幂等键应独立；同设备同操作重发应命中同一记录；同一幂等身份不同实际参数应报冲突。
不能仅把device_id加列，保留原跨设备唯一键使第二台车仍冲突。
不同服务键不是必须出现在每个索引；逐项以实际生成器与执行语义决定并写明，不机械膨胀所有键。

## D. Snapshot / Cursor / Revision

当前ugv_state_snapshot初始主键为revision；共享设计必须消除“所有设备同revision冲突”。
建议键：(device_id,source_session_key,revision)，或全局snapshot_id +上述源唯一键。
来源session必须实际取得；没有session时使用明确稳定的源实例范围，不默认任意'unknown'作为真实设备会话。
读取最新状态必须WHERE device_id=...并限定相应source/channel，不能全表ORDER BY observed_at LIMIT 1。
latest_snapshot_revision的关联查询需要同设备/来源；不能只按revision JOIN。
业务事件stream、mapper cursor、provider缓存key同样检查设备范围。
状态缓存的“最新”按现有状态语义，不把received_at冒充设备观测时间。

## E. 任务领取、恢复与所有者

GOWM提供可测试的数据访问函数/Repository样例，不重写SMPP或SDAR调度引擎。
接口要求明确allowedDeviceIds/deviceId；缺失时返回参数错误，不扫描所有设备。
领取流程沿用现有可运行状态筛选与claim机制；FOR UPDATE SKIP LOCKED只解决竞争，不解决设备路由。
两个Worker负责同一设备时不得同时领取同一执行；Worker A仅负责设备A时不得领取B。
恢复任务、补发outbox、处理响应inbox、TTL扫描等也按其负责的设备/业务范围执行。

Lease标识必须区分：
- DEVICE / TASK级资源：包含设备或全局Task身份。
- SERVICE级公共工作：稳定service/job范围。
- Worker owner：可变处理者。
同一受保护资源的竞争者必须争用同一个lease key；不能把workerId加入lease key让每个Worker各拿一把锁。
新增示范claim函数只用于证明存储接口，并在后续手册映射到当前claim代码；不要创建第二个生产任务状态机。

## F. 两个设备不能共享一个可变“本车上下文”

核查singleton、latest、provider revision、active operation索引、固定sourceId、client/session等所有隐式单实例假设。
每项给出：
源路径；现有约束；共享后范围；GOWM DDL/查询改动；后续应用改动；测试编号。
把进程配置硬编码的resource/adapter URL改造留给SMPP任务，但此处必须在交接中指出，不宣称表共享即运行支持多设备。
与设备无关的配置singleton保持业务全局，不无谓复制。

## G. TTL / 删除

Task句柄过期仍按源协议表达；不能自动删除用于任务历史的Task、Dispatch、Mission Link。
保留协议过期字段，GOWM默认角色不执行业务历史清理；提供明确retention合同。
不得偷偷用trigger忽略DELETE，让旧清理器以为已删除。
后续SMPP必须适配purge路径才能上线；本轮用测试证明句柄过期标记不使JOIN历史消失。
