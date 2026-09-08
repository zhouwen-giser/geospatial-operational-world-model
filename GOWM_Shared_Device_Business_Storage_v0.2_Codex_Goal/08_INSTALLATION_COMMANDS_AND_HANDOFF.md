# G08 — 安装、配置、仓库交付与后续接线

## 建议仓库产出

```
docs/device-business-storage-v0.2/
  architecture.md
  data-dictionary.md
  source-inventory.json
  native-transform-map.json
  device-scope-key-inventory.json
  repository-adaptation-matrix.md
  read-model-mapping.json
  transaction-and-retention-contract.md
  smpp-handoff.md
  sdar-handoff.md
  mqtt-ingest-handoff.md

contracts/device-business-storage-v0.2/
  storage-contract.json
  request-result schemas或TS类型说明
  examples/
  manifest.json

database/migrations/
  <next>_device_shared_business_foundation.sql
  后续必要公共迁移

database/shared-business-storage/
  源迁移、托管转换、固定Schema安装产物及overlay

packages/integrations/device-business-storage/
  src/
  tests/

scripts/device-business-storage/
  cli.ts

reports/device-shared-business-storage-v0.2/
  FINAL_REPORT.md
  FINAL_REPORT.json
```

路径按现有workspace调整，不能为了该功能改造成另一个构建系统。
不把原生业务库的几十份迁移混入GOWM core数字序列；新增core公共表不修改原有迁移校验值。
发现现有检查需要识别新增文件，只做精确的增量扩展，不禁用原有guard、不整体重写历史freeze lock。

## 建议新增命令（命令必须真实实现）

```
npm run business-storage:check
npm run business-storage:install -- --domain all --help
npm run business-storage:install -- --domain smpp
npm run business-storage:install -- --domain sdar
npm run business-storage:verify
npm run business-storage:test:postgres
npm run business-storage:fixture -- --help
npm run business-storage:handoff
```

命令语义：
- check：静态校验来源、安装清单、9表合同、生成物一致性，不连接数据库。
- install：在指定数据库安装当前GOWM所需公共表和选定固定共享domain；核心未满足前置时报具体依赖，不静默创建假的world_object。
- verify：检查实际DB中的表/列/FK/索引/函数/迁移family及固定Schema，输出结构结果，不假装应用已接线。
- test:postgres：在隔离数据库执行真实事务、双设备与读写测试。
- fixture：仅显式测试数据库允许写模拟行，重复执行幂等；正常命令不自动污染运行数据库。
- handoff：打包当前DDL、列/键变更、连接配置、SQL样例、来源清单和测试摘要，不执行消费端改造。

命令help必须无需DB就成功。实际验证缺环境返回NOT_RUN，不以退出0+PASS冒充已测；总报告正确汇总。

## 配置

复用现有实际database name，不新建硬编码业务database：
```
GOWM_DATABASE_URL=<existing database>       正常安装由部署者明确指定
GOWM_BUSINESS_TEST_DATABASE_URL=<isolated test database>
GOWM_BUSINESS_SMOKE_ENABLE=false
```

不提供真实凭据，不自动连接用户正在运行的实例。
连接模板可说明SMPP/Provider使用同一个数据库+ugv_smpp，SDAR使用同一数据库+ugv_sdar。
禁止全库默认deviceId。后续消费者每次业务请求传deviceId，Worker传明确allowedDeviceIds。

## 安装与既有数据

本轮是新存储准备，不执行历史回填、在线切换、清空旧数据。
安装器遇到未知但非空的业务Schema，不执行DROP/重建；输出已检测结构和最小处理提示。
若已存在本设计的已登记版本，使用幂等前向迁移。
测试不因避免误删而引入复杂多级审批，只需显式隔离DB、标记和已知测试行前缀。
禁止在测试失败时全库DROP SCHEMA CASCADE清理运行库。
core角色/扩展在同集群其他库可见，测试创建角色须避免影响既有角色，或复用既有测试配置。

## 三份独立消费者交接

### SMPP
明确：
- 连接固定ugv_smpp
- 根记录device_id/binding_id写入
- scoped idempotency/snapshot/cursor/claim SQL的替换点
- 对真实resource/adapter路由的设备绑定
- 迁移verify-only
- Task句柄过期与长期历史保留
- Provider Mission Link与派发回执同事务写入

### SDAR
明确：
- 连接固定ugv_sdar
- Task设备归属、Plan/Node Run实际关联
- native/public SQL适配、源键命名空间
- Remote Task关联逻辑smpp_service_key
- 目标图形及实际使用修订落库
- 任务领取/恢复的device范围
- 不直接插入SMPP任务来代替MCP调用

### MQTT Ingest
明确：
- 从设备配置读连接/路由
- message→唯一deviceId
- 原生Mission身份保留来源session
- observer/device与subject不同
- 不更改旧会话上下文解释历史消息

**不产出声称已应用的跨仓补丁，不修改三个消费者仓库。**
后续接线风险必须按明确代码位置列出，不能仅写“改连接串即可”。
