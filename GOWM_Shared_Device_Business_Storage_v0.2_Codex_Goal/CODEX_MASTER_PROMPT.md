# Codex Goal — GOWM 设备中心化共享业务存储 v0.2

## 立即执行的任务

目标仓库：
`https://github.com/zhouwen-giser/geospatial-operational-world-model`

仅在该仓库完成：
**设备主档 + 固定共享ugv_smpp/ugv_sdar业务Schema + device_id范围 + 目标图形 + Task到Mission关联存储 + 双设备真实数据库验证。**

不要停在设计文档。按本包00—11实施代码、正式DDL、安装器、Typed Repository/SQL访问、测试、文档和交接。
本任务不授权修改SMPP、SDAR、GDPS、WSGS、SACS或Analysis Provider。它们只作为读取的原生Schema/Repository来源。

## 最新用户决策，覆盖旧草案

1. 所有UGV共用`ugv_smpp`和`ugv_sdar`。
2. 通过`device_id`区分业务归属，不为设备/运行实例创建业务database或Schema。
3. 不创建`business_store`，不在新公共合同使用smpp_store_id/provider_store_id/sdar_store_id。
4. `device_runtime_binding`改为`device_service_binding`，只保存设备到稳定逻辑服务/Agent/Provider/Resource的绑定。
5. 运行worker实例仅作为claim/lease owner，不决定任务身份或存放位置。
6. 业务记录一份主存储，不建Task影子表、不导出、不CDC、不增加同步器。
7. SDAR的Task/目标/Plan/Workflow/Node Run以及SMPP执行/Mission都必须保留，不能缩水成taskId-missionId三列。
8. GOWM提供存储；SDAR/SMPP/Provider仍负责各自业务动作，不能用SQL INSERT替代MCP调用。

旧附件`GOWM_Device_Business_Storage_v0.1_Design_CN.md`与`...design.sql`的按实例存储部分已废止。本包不附旧SQL，禁止执行它。
若其已成为运行库迁移，不破坏既有数据；本轮新共享方案采用增量且旧数据切换另议。

## 固定布局

```
现有GOWM database
├─ 既有GOWM Schema / ugv_ingest      保持
├─ gowm_device                      4张公共表
├─ gowm_task                        2张公共表
├─ gowm_execution                   3张公共表
├─ ugv_smpp                         Runtime + UGV原生共享业务库
├─ ugv_sdar                         SDAR原生共享业务库
└─ gowm_business_v1                 固定只读查询
```

公共表：
- gowm_device.device
- gowm_device.mqtt_endpoint
- gowm_device.device_stream
- gowm_device.device_service_binding
- gowm_task.target_geometry
- gowm_task.target_binding
- gowm_execution.device_mission
- gowm_execution.mission_identity
- gowm_execution.execution_mission_link

9张不包括源应用原生表和必要迁移metadata。

## 首先核对

阅读仓库AGENTS.md，检查本地未提交修改，fetch最新分支；不覆盖他人工作。
建议分支：`codex/gowm-device-shared-business-storage-v0.2`。

包生成时已观察：
- GOWM main dd1b038fa0fa3e3893d7f4c7f815bfe9992b0838
- SMPP main b974471dd62665721a5edcc63b7651d2f476160d
- SDAR main cb50da8ec8d160a673852be8bcdfc3bb094f5ce5

执行时重新对账，不以旧SHA阻碍功能开发，也不为追新反复重启任务。
只读源：
`zhouwen-giser/sdar-mcp-provider-platform`
`zhouwen-giser/skill-driven-agent-runtime`

读取实际migration runner、baseline、后续增量、Repository SQL和任务/快照/幂等/lease/TTL路径；生成完整来源和共享设备键清单。
本包示例字段不允许替代真实源结构核查。

## 实施重点

### 设备与绑定
device_id复用world_object.id；沿用data_scope、source_registry、pipeline、datastream。
MQTT地址可多设备共享，topic/payload必须唯一识别设备；无匹配不默认ugv1。
绑定使用稳定service key和Resource，不带storeId。
改名、换服务、worker重启不能重写历史device归属。

### 原生业务安装
安装完整当前SMPP Runtime+UGV family到ugv_smpp；SDAR当前运行库依赖到ugv_sdar。
不得只创建空Schema或几个摘要表。
原生迁移独立记账，不能混入GOWM core数字序列；完整文件名区分SMPP两个合法014。
SDAR基线有public.*和vector，需namespace-aware转换表/函数/序列/FK/search_path，不能直接重放或全文件字符串替换。
公用扩展留在实际管理Schema，缺vector时如实报告，不用假表代替。
迁移准备在GOWM；后续消费者禁用自行重复迁移或verify-only。

### 真正支持共享设备范围
根业务记录显式device_id/binding_id；无全库默认设备。
按真实范围修订快照revision、event source、cursor、Idempotency和lease唯一键。
任务领取/恢复显式allowedDeviceIds，SKIP LOCKED不替代设备路由。
同设备同任务并发只一个claim；不同设备同本地编号不碰撞。
同库不自动产生跨服务原子事务，不把设备调用置入事务。
不可分的Admission/Dispatch/Idempotency持久化不得当缓存删掉。

### 目标与Mission
目标保留native_geometry/native_crs及可选标准WGS84；未知frame不得伪装经纬度。
Task要求、Plan采用、实际派发分别绑定精确目标修订。
Mission按device+channel+真实来源session/identity关联；Provider epoch不自动等于MQTT epoch。
回执不确定保持PENDING/UNCERTAIN；控制操作不自动创建新Mission。
具体Dispatch Step不是SDAR Workflow Node；nodeId重复的不同Node Run不能合并。

### 固定读取与交接
实际完成Task→目标→Plan/Node Run→MCP→Execution→Dispatch→Mission正反查询。
读取固定原生表，不复制；缺关联返回缺失阶段，不能当作没执行或执行成功。
给出SMPP、SDAR、MQTT后续单仓适配清单，指出真实Query/字段/cleanup变更。
不声称未修改的应用只改连接串就能运行多设备。

## 阶段

P0来源盘点 → P1合同收口 → P2设备与绑定 → P3原生固定Schema安装
→ P4设备范围overlay → P5目标/Mission → P6双设备验证 → P7报告和交接。

合同收口是同一任务中的实现准备，不额外等待人工确认，不增加产品级门禁。

## 验证

现有：
```
npm run check
npm run build
npm test
npm run verify:sql
```

新增必须真实可执行：
```
npm run business-storage:check
npm run business-storage:install -- --help
npm run business-storage:fixture -- --help
npm run business-storage:handoff
npm run business-storage:test:postgres
```

默认不要求Docker；真实数据库可本机或专用现有测试实例。
不要连接/修改未授权生产库。仅明确隔离测试库写双设备Fixture。
缺数据库时仍继续完成源码与所有无环境测试，DB=NOT_RUN，不让环境缺失阻断所有开发。
但Mock/AST不能当作真实PostgreSQL通过。

## 交付

GOWM代码、DDL、安装/verify脚本、9表字典、native变换清单、设备范围键清单、
双设备36场景测试、Task↔Mission实际读取、3份后续消费者交接、FINAL_REPORT.md/json。

可按功能提交4—6个commit；数量不是门禁。
有远端权限则push GOWM功能分支、创建Draft PR，不merge/tag/release。
远端权限不足如实报告，不否定本地已验证实现，不伪造链接。

最终标志三选一：
- 全部代码与真实DB验证通过：GOWM_DEVICE_SHARED_BUSINESS_STORAGE_DEV_READY
- 代码与无环境验证完成但真实DB未运行：GOWM_DEVICE_SHARED_BUSINESS_STORAGE_SOURCE_READY
- 必需功能或测试失败/未完成：GOWM_DEVICE_SHARED_BUSINESS_STORAGE_INCOMPLETE

始终明确：
SMPP_RUNTIME_ADAPTATION_NOT_PERFORMED
SDAR_RUNTIME_ADAPTATION_NOT_PERFORMED
LIVE_MQTT_SWITCHOVER_NOT_PERFORMED

详细执行要求见FULL_CN.md或00—11章节；acceptance.json为40项验收索引，test-scenarios.json为36个功能场景。
