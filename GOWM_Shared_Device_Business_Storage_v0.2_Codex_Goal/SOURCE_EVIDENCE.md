# 来源、已核查事实与未验证边界

生成日期：2026-09-08。当前文件是任务包来源说明，不是代码审计或数据库通过报告。

## 用户明确决策

- GOWM是设备主档与共享业务存储管理方。
- 所有UGV共享ugv_smpp/ugv_sdar，通过device_id区分。
- 不为每个运行实例/设备安装一套业务库。
- 任务与目标图形、Workflow/Step Run、MCP Task、Provider执行和Mission都需要保留。
- 只改GOWM，其他仓库按冻结合同随后分别适配。
- 不要重复导出采集业务记录，不要产品级治理阻碍开发。

## 本轮实际读取

|编号|来源|读取范围/结论|
|---|---|---|
|R1|GOWM refs/heads/main|dd1b038fa0fa3e3893d7f4c7f815bfe9992b0838|
|R2|SMPP refs/heads/main|b974471dd62665721a5edcc63b7651d2f476160d|
|R3|SDAR refs/heads/main|cb50da8ec8d160a673852be8bcdfc3bb094f5ce5|
|R4|GOWM package.json|0.7.1；check/build/test/verify:sql与db:migrate等脚本存在|
|R5|GOWM scripts/migrate.ts|core数字序列、换行Hash、schema_migration及角色设置；不能混入外部不连续迁移|
|R6|SMPP migrations/runtime/002_task_lifecycle.sql|Task、Admission、Idempotency、Observation、Outbox、Lease等完整依赖；幂等基础键不含device维度|
|R7|SMPP migrations/providers/ugv/024_ugv_provider.sql|UGV Execution、ACK、Snapshot、事件流；snapshot以revision作主键|
|R8|SDAR infra/postgres/baseline/0001_sdar_v1_2_2_baseline.sql，前105行|显式public对象、函数与search_path语句、vector；不是可直接重放到GOWM public的脚本|
|R9|对话附件Design_CN.md全文|旧设计按store托管且跨表引用store_id，现已被用户最新决定取代|
|R10|对话附件design.sql全文|旧10张公共表SQL仅设计草案；本包不随附、不执行它|

所有当前分支后续可能更新。实施时重新读取真实安装入口与完整依赖；不能仅根据本表的代表性文件宣称已审完全部表、全部运行实例或运行数据。

代码位置（固定读取来源）：
```
https://github.com/zhouwen-giser/geospatial-operational-world-model/blob/dd1b038fa0fa3e3893d7f4c7f815bfe9992b0838/package.json
https://github.com/zhouwen-giser/geospatial-operational-world-model/blob/dd1b038fa0fa3e3893d7f4c7f815bfe9992b0838/scripts/migrate.ts
https://github.com/zhouwen-giser/sdar-mcp-provider-platform/blob/b974471dd62665721a5edcc63b7651d2f476160d/migrations/runtime/002_task_lifecycle.sql
https://github.com/zhouwen-giser/sdar-mcp-provider-platform/blob/b974471dd62665721a5edcc63b7651d2f476160d/migrations/providers/ugv/024_ugv_provider.sql
https://github.com/zhouwen-giser/skill-driven-agent-runtime/blob/cb50da8ec8d160a673852be8bcdfc3bb094f5ce5/infra/postgres/baseline/0001_sdar_v1_2_2_baseline.sql
```

## 数据库语义参考

PostgreSQL Schemas：
```
https://www.postgresql.org/docs/current/ddl-schemas.html
```
一个连接直接访问一个database中的多个schema；未限定对象名由search_path解析。应用Schema与public扩展必须分别处理。

PostgreSQL Constraints：
```
https://www.postgresql.org/docs/current/ddl-constraints.html
```
复合键/外键用于约束同设备父子关系。跨表多态owner检查不能只写成一个普通CHECK。

PostgreSQL SELECT：
```
https://www.postgresql.org/docs/current/sql-select.html
```
SKIP LOCKED用于队列类并发，不提供设备路由/归属判定。

PostGIS：
```
https://postgis.net/docs/ST_SetSRID.html
```
ST_SetSRID只改SRID元数据，不转换坐标。目标坐标转换要有明确CRS依据。

以上只用于实现语义参考，不要求升级到文档“current”的PostgreSQL版本。以项目实际支持环境为准。

## 本轮未做

未修改仓库；未执行GOWM/SMPP/SDAR测试；未安装DDL；未连接用户数据库；未生成真实设备Mission。
任务包文件完整性通过，不代表上述项目验证已经通过。
