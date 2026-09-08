# G00 — 目标、来源与单仓边界

## 目标

在 `zhouwen-giser/geospatial-operational-world-model` 实际实现设备中心化共享业务存储。GOWM 管设备主档和数据库；所有 UGV 共用 `ugv_smpp` 与 `ugv_sdar` 两个固定业务 Schema，业务记录通过 `device_id` 归属设备，通过明确的 Task / Step Run / MCP Task / Execution / Mission 身份形成关联。

本任务不是设计文档任务。必须交付正式迁移、可重复安装器、源结构适配、数据访问实现、双设备测试和后续消费者接入合同。

**仅修改 GOWM 仓库。** SMPP、SDAR、GDPS、WSGS、SACS、分析 Provider 仓库只读；不提交跨仓修改、不启动设备控制、不迁移现有运行数据。

本任务版本 `v0.2` 是对旧设备业务库草案的设计修订，不要求把 GOWM 软件版本改成 0.2，也不默认升级 GOWM 根 package version。

## 权威优先级

1. 用户最新决策：固定共享业务域、device_id 隔离、禁止每实例建库。
2. 本任务包的目标和数据合同。
3. 执行时读取的当前仓库实际类型、迁移与业务语义。
4. 旧 v0.1 设计仅供理解，不作为可执行输入。

旧文件：
- GOWM_Device_Business_Storage_v0.1_Design_CN.md
- GOWM_Device_Business_Storage_v0.1_design.sql

其中 `business_store`、`device_runtime_binding` 的实例存储绑定、动态实例 Schema、`*_store_id` 跨库关联被本任务取代。不得直接执行旧 SQL。

如果本地没有旧文件，不影响执行；本包已完整说明替代内容。若旧草案已进 Git，只修改草案或新增更正，不覆盖已经执行过的迁移，不 DROP 现有有数据的表。

## 仓库和观测基线

本包于 2026-09-08 读取：
- GOWM main: dd1b038fa0fa3e3893d7f4c7f815bfe9992b0838
- SMPP main: b974471dd62665721a5edcc63b7651d2f476160d
- SDAR main: cb50da8ec8d160a673852be8bcdfc3bb094f5ce5

这些 SHA 是来源记录，不是执行门禁。开始先阅读 AGENTS.md，再 fetch 当前远端。GOWM 从最新可用主线或已有明确相关开发分支创建：
`codex/gowm-device-shared-business-storage-v0.2`

不为了追逐 SHA 反复重跑测试；报告本次实际基线即可。不得改写他人的工作区、强推、自动合并、打 Tag 或发布。

## 必须先做的源码盘点

GOWM：
- world_object / data_scope / world_reference_identity
- source_registry / producer_pipeline / datastream
- world_observation / measurement / entity_binding
- ugv_ingest 全部表与当前 Mapper 身份逻辑
- scripts/migrate.ts、SQL验证器、版本/迁移冻结检查

SMPP：
- migrations/runtime、migrations/providers/ugv 的当前完整集合
- Migration Resolver 与 Runtime/Provider安装入口
- persistence-postgres、UGV store 实际 SQL
- Task领取、Idempotency、命令Claim、Lease、Snapshot、Cursor、TTL/Purge路径

SDAR：
- 当前运行库 baseline 和实际后续增量入口
- agent_task、Goal/Plan、Workflow/Node Run、mcp_invocation、remote_task_binding
- Repository事务边界、schema-qualified SQL、vector依赖
- 不纳入独立 Node Control 管理库，除非某项已证明为运行库不可分依赖

产出 `source-inventory.json` 和 `repository-adaptation-matrix.md`。每个有关的源表/字段应记录真实路径、身份键、设备归属方式、是否修改以及验证方法。不要把任务包中建议的原生表名当作未经核实的事实。

## 两个明确边界

存储统一 ≠ 执行引擎统一。SDAR 仍经 MCP 调 SMPP，SMPP/Provider 仍经原协议派发设备。
同库 ≠ 跨服务原子提交。不得把设备网络调用放入数据库事务，也不得宣称一次数据库提交保证物理 exactly-once。
