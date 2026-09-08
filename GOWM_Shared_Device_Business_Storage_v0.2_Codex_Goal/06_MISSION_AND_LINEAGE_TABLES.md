# G06 — Mission身份与执行关系：三张公共表

## gowm_execution.device_mission

mission_instance_id uuid PK；
device_id / data_scope_key；
mission_channel text（例如CHASSIS或OBSERVATION；实际值通过适配合同明确）；
world_object_id text NULL（已存在GOWM Mission对象时引用）；
created_by、created_at。

同一Mission世界对象不重复登记；验证与设备scope一致。
不建立第二份运行状态机，不复制provider state当作GOWM真值。
Mission尚未创建或信息不足时，不为补齐图而虚构实例。

## gowm_execution.mission_identity

identity_id uuid PK；
mission_instance_id；
device_id、mission_channel；
authority_key、identity_kind、native_session_key、native_mission_id；
evidence_ref jsonb；
created_at。

唯一键：
(device_id,mission_channel,authority_key,native_session_key,native_mission_id)。

identity_kind可为MISSION_ID_WITH_SESSION / RUN_KEY / EXECUTION_SCOPED_ID。
native_session_key必须有真实来源；只有Provider execution范围可用时明确EXECUTION_SCOPED_ID，不假装设备全局session。
不同设备相同mission_id允许共存；同设备不同原生会话复用mission_id允许共存。
Provider局部epoch和MQTT ingest局部epoch没有自动等价关系。
同一Mission可以有多个明确验证的别名；没有共同回执/命令身份时保持未解析，不能按时间接近合并。

## gowm_execution.execution_mission_link

字段：
- link_id uuid PK；device_id / data_scope_key；binding_id。
- mcp_task_id：对应共享ugv_smpp当前原生Task主键类型，初始可为空。
- provider_execution_id：真实外部Execution身份。
- provider_task_record_id：ugv_execution真实主键，不能默认等于MCP ID。
- provider_dispatch_step_id：Provider派发日志步骤，不是SDAR Node。
- mission_instance_id NULL。
- relation_kind：CREATED / CONTROLLED / OBSERVED。
- link_state：PENDING / LINKED / UNCERTAIN / CONFLICTED。
- source_system_key、idempotency_key、source_evidence_ref jsonb。
- unresolved_native_identity jsonb NULL；created_at / updated_at。

**不含smpp_store_id/provider_store_id/sdar_store_id**。
明确mcpTask身份若已存在，应校验同设备。异步接纳尚未形成MCP task时允许为空，并在已有业务回执事务补齐，不建立强制错误写入顺序。
派发记录存在性和同设备由固定Schema FK/写入验证保证；不得用跨服务FK强迫尚未发布的父记录先提交。

关系原则：
- LINKED必须有mission_instance_id与明确证据。
- PENDING没有已确认Mission是正常情况。
- UNCERTAIN/CONFLICTED不强制删除已有证据引用，但不得在公共查询中显示为“已确认关联”。
- 一Task可零到多Mission；一Mission可被多个控制派发引用。
- 一派发确实返回多个Mission时保留多条明确关联，幂等键包括稳定来源事件/分项身份。
- 重复同一个回执不新增重复关联；不同载荷却相同幂等身份返回冲突。
- 下游MISSION数字数组只能作为汇总，不替代逐派发证据。

## 读取关系

SDAR remote_task_binding
→ 真实MCP Task身份及稳定smpp_service_key
→ ugv_smpp.provider_task
→ ugv_execution
→ ugv_mutation_journal
→ execution_mission_link
→ device_mission / mission_identity。

在G00核对Repository实际赋值后确定JOIN，禁止只因列都叫task_id就判定相等。
接口返回缺失阶段：
NO_REMOTE_TASK / PROVIDER_PENDING / MISSION_UNRESOLVED / LINKED / CONFLICTED。
不要把缺少关联解释为“从未执行”，也不要把LINKED解释为“任务物理完成”。

与GOWM已有Mission world_object关联时只引用同一对象；不新建重复world object。
设备遥测仍正常进入既有观测链；此任务只提供身份写入和查询，不启动MQTT同步，不产生合成Operational Event。
