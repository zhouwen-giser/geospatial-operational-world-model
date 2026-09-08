# G07 — 实际可调用的存储合同与公共读取

## 交付原则

不能只交付DDL。GOWM仓库中实现一个小型共享业务存储包，放到现有workspace可包含的位置，例如：
`packages/integrations/device-business-storage/`。

它包含：
- typed配置/请求/结果模型
- pg事务内的设备/目标/Mission写入函数或Repository
- 固定Schema读取Query
- 安装、校验、Fixture CLI
- 测试使用的同一实现

这不是新的执行编排器。SMPP/SDAR后续可以用其合同/SQL适配现有Repository；不得要求两仓必须引入新的复杂运行时平台。

## 写入事务合同

下列建议入口可以采用TS Repository，或少量SQL函数+TS包装。选择一套实际实现，不同时维护两份同义逻辑：

registerDevice
registerDeviceStream
replaceDeviceServiceBinding
attachTargetToOwner
registerMissionIdentity
linkExecutionToMission

每项明确：
- 参数及设备Scope
- 原生记录身份
- 幂等或重复处理
- 同设备/同Scope校验
- 必要的事务边界
- 返回的持久化ID及错误码

只读世界对象/观测不能被这些函数改写为设备执行事实。登记已有设备可更新设备管理属性，不替换原observed state。

原生Task/Invocation/Execution的完整创建继续由原应用负责。
本包提供供后续适配的设备范围查询/写入样例与验证，不重新实现SMPP状态机。
若必须新增一个helper SQL支持共享幂等或claim，应复用原有状态字段并标明它是存储原语，不是第二份Task表。

## 固定只读Schema

`gowm_business_v1` 至少提供以下视图，逐项验证真实字段映射：
- device_catalog
- device_ingest_routes
- device_service_bindings
- sdar_tasks
- workflow_steps
- mcp_tasks
- provider_executions
- provider_dispatches
- mission_links
- task_target_geometries
- task_execution_lineage

视图只读，不使用可写VIEW代替旧Repository兼容层。
所有设备行输出device_id；业务身份输出必要source namespace，不能回到storeId/动态Schema。
source table和上游字段映射放在 `read-model-mapping.json`。

## 查询函数/Repository

提供少量明确输入的查询方法：
```
listDeviceTasks(deviceId, timeRange?, limit, cursor?)
getTaskLineage(deviceId, sdarTaskId)
getMissionLineage(deviceId, missionInstanceId)
getTaskTargets(deviceId, taskId)
getMcpTaskDetails(deviceId, mcpTaskId)
getLatestDeviceSnapshot(deviceId, sourceKey?, channel?)
```

- deviceId必填；全设备管理汇总用另一个明确命名的调用，不以NULL表示所有设备。
- ID查到别的设备记录时不得返回；FK与读取校验均需测试。
- 相同设备不足以关联Task，必须使用明确的Task/Node Run/MCP/派发ID。
- 排序稳定，基本分页有界；不用复杂游标认证框架。
- left join保留未启动节点、未完成回执、未解析Mission，不能inner join丢掉未执行计划。
- 并行/循环/子Workflow的不同Node Run分开；同nodeId两次尝试不能合并。
- JOIN扇出需按真实实体列表分组，不通过DISTINCT任意抹掉不同执行。
- 结果分开包含sdar状态、mcp状态、provider状态、mission关联状态；不生成统一“成功”字段。
- GOWM observation中subject是被观察目标时，禁止以subject_id=device_id硬拼全部传感器观测。

## 目标Owner验证

owner_domain和owner_kind映射到固定表白名单；owner_key包含实际完整键。
不得把owner_key直接当table name或SQL片段。
PLAN_NODE读取对应Plan中真实definition JSON验证node存在；NODE_RUN读取真实执行记录和attempt，不编造Node Run。
实际源结构若不提供统一nodeRun表，可以按现有事件/绑定记录建立只读投影，写入验证仍要有真实出处。

## Scope与权限

沿用GOWM已有data_scope与角色模式；基本写入函数只允许自己的数据域。
不创建逐设备数据库用户，不要求新JWT/RLS/Policy系统。
跨设备FK和Scope校验属于数据正确性；凭据只通过现有env/secret引用供部署者设置。
shared roles不能修改GOWM原有核心表状态；公共读取不暴露token、密码、原始认证headers。
