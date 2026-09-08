# GOWM 共享设备业务存储 v0.2 最终报告

**GOWM_DEVICE_SHARED_BUSINESS_STORAGE_DEV_READY**

仅修改 GOWM。已交付正式 078 公共迁移、完整原生安装、设备范围 overlay、事务内存储接口、11 个只读视图、Task↔Mission 查询及三份消费者接入说明。未创建 business_store、实例级业务 Schema、Task 影子表或新增业务导出同步器。

## 实际来源与安装

- GOWM 实施基线 `f7fd19b75e026622fa1bf3a56241cd98ca59e478`；origin/main `dd1b038fa0fa3e3893d7f4c7f815bfe9992b0838`。本地基线含 10 个既有前置提交，不改写这些提交。
- SMPP `30ca575dc9c3907089a53e1fdccd69c95c2cbdc8`；SDAR `cb50da8ec8d160a673852be8bcdfc3bb094f5ce5`。只读工作区 migrations 无未提交修改。
- SMPP resolver 的 Runtime 27 份（两个 014 均保留）+ UGV 5 份；SDAR 按真实 planPostV122MigrationFiles 安装 baseline + 76 份增量。共 109 份原生迁移，独立 family+完整文件名+SHA-256 记账。
- 实际 ugv_smpp 35 表、ugv_sdar 222 表，均含各自一张 GOWM 安装 history；SDAR 自身 schema_migration 仍保留。另有公共九表与 11 视图。没有安装独立 Node Control/PMS 管理库。
- AST 变换区分应用对象与 public.vector；重定位 identity 序列并固定函数 search_path。3 张被 SDAR 后续迁移主动删除的旧遥测表记为历史来源，不误报安装缺失。
- 公共九表及所有列/键/来源分类见 [交接数据字典](../../docs/shared-business-storage-handoff/data-dictionary.md)、[设备键清单](../../docs/shared-business-storage-handoff/device-scope-key-inventory.json)。

## 实现与实际验证

PostgreSQL 18 隔离测试容器，PostGIS 3.6.4、pgvector 0.8.6。最终库为新建隔离测试库；真实重放 GOWM 001–078 后安装全部原生域。未连接或改写运行数据库、MQTT broker 或消费者应用。

42 个数据库用例全部通过，覆盖任务包 T01–T36 与补充场景：

- 两台设备共用同一套表；相同 native Mission=7、snapshot revision=1、source sequence=1、幂等文本可独立保存。SMPP 幂等重发返回原 Task，不同参数报冲突；SDAR 初始 Admission 的相同 caller key 也经过完整 capability binding/attempt 的真实双设备验证。
- 同设备父子关系与 Scope 受复合 FK/触发器检查；A 更换服务绑定后历史归属不漂移。
- MQTT 路由纯函数不做 ugv1 默认回退；实际配置入口拒绝 BOUND_DEVICE 通配符重叠。
- 两连接竞争只一方领取；设备范围过滤、重启 owner、过期 claim 恢复、设备资源 Lease 互斥、SDAR remote poll 均通过。服务 Lease 使用独立 SERVICE 范围，不伪造设备。
- Point/Line/Polygon 标准化；未知坐标系保留 NATIVE_ONLY；目标修订不可覆盖。Task 创建与目标绑定失败后整体回滚。
- 每台设备 3 个 Node Run（含 move 重试）、3 个 MCP Task、3 个 Execution、6 个 Dispatch。A 正向读取 6 行链，1 个 LINKED，其余为未解析阶段；反向 Mission 查询回到正确 Task。目标和事件分别返回，未按重复 nodeId 合并执行。
- 重复回执幂等、冲突载荷拒绝、UNCERTAIN 不虚构 Mission，控制派发不能使用 CREATED 创建关联。句柄过期标记后历史 JOIN 保留。
- 独立安装 smpp 后再安装 sdar 成功；重复安装不增加 history，新设备无需 DDL。实际 verify 比较列、约束、索引、函数、触发器、视图及完整 migration ledger。

|命令|结果|
|---|---|
|npm run check|PASS，退出 0|
|npm run build|PASS，退出 0|
|npm test|667 通过，19 个既有环境条件跳过，退出 0|
|npm run verify:sql|PASS，退出 0|
|npm run business-storage:check|109 原生迁移哈希/生成物一致性、6 个静态测试通过|
|install / fixture --help|无 DB 可运行，退出 0|
|install --domain smpp / sdar|真实独立安装通过|
|fixture / test:postgres / verify|真实写读、42 用例、完整结构校验通过|
|business-storage:handoff|DDL、许可证、合同和验证摘要已生成|
|缺 DB 参数的 test:postgres|NOT_RUN，退出 2（预期负向验证）|
|独立缺 vector 测试库的 install|明确 DEPENDENCY_MISSING，退出 1；SMPP 已独立完成|
|最终补充类型检查|PASS，退出 0|

完整逐项结果、命令退出码、扩展版本和查询结果在 [FINAL_REPORT.json](FINAL_REPORT.json)、[postgres-results.json](postgres-results.json)。最初受沙箱限制的既有子进程/监听测试已在正常测试权限下重跑通过；未通过删测试或改 skip 获取成功。SQL 原文与 PostgreSQL deparser 的空白保留在受 hash 管理的文件中。

## 消费者后续最小接点

[三仓接入矩阵](../../docs/shared-business-storage-handoff/repository-adaptation-matrix.md)和独立 SMPP/SDAR/MQTT 文档已给出真实路径、字段与清理改动。SMPP/SDAR 必须适配显式 device/binding、冲突键、claim/recovery、session/snapshot/cursor SQL、固定 search_path 与 migration-disabled/verify-only。历史 purge 不能直接沿用。设备动作继续经 MCP/Provider，不能用 SQL INSERT 替代，也不把设备网络调用放入数据库事务。

以下状态保持不变：

- SMPP_RUNTIME_ADAPTATION_NOT_PERFORMED
- SDAR_RUNTIME_ADAPTATION_NOT_PERFORMED
- LIVE_MQTT_SWITCHOVER_NOT_PERFORMED
- 历史运行数据回填/切换 NOT_PERFORMED

## 交付

功能分支 `codex/gowm-device-shared-business-storage-v0.2`，实现提交 `718a0b81f8dccde7bc111a0e781fc436f633c441`。已推送，并创建 [Draft PR #21](https://github.com/zhouwen-giser/geospatial-operational-world-model/pull/21)。验证报告提交 `f8a06a6540b55e7a6d0a4418c27d0544e27cc759`；本交付记录作为后续文档提交。该分支包含基线已有的 10 个前置提交；本任务没有改写已有 main 或纳入现有未跟踪部署输出。未 merge、tag 或 release。
