# G03 — 固定共享业务库的实际安装

## 安装范围与关系

固定 `ugv_smpp` 同时承载SMPP Runtime和UGV Provider原生业务表；固定 `ugv_sdar` 承载SDAR运行库原生记录及其不可分依赖。
这里“原生”指保留业务字段与状态语义，不意味着旧二进制可无修改连接共享库。共享设备键和约束是本任务必须产生的存储侧变更，应用接线随后各仓库独立实施。

不得只建空Schema，或手写Task/Mission三张简化表后声称完成。
不得把原生库放到另一个database，再通过视图/FDW/同步器拼回来。
不得在GOWM创建Task、Plan、MCP Task的第二份影子表。

## SMPP Runtime

从当前安装入口取完整runtime migration family，不只重放002文件。
公共读取重点：
- operation_snapshot
- provider_task
- admission_intent
- task_observation
- task_input_request
- idempotency_record
- command dispatch / control
- outbox / inbox
- 运行恢复、timing、lease及当前实际依赖

只读核实PMS配置或其他表是否为真实执行依赖；独立PMS管理数据库、其他设备Provider、诊断平台不扩大搬迁。
遇到名字相同的表/类型/索引，先核对语义。不同family共享ugv_smpp时必须消除实际命名冲突，但保持一个固定Schema；转换映射写入manifest。

## UGV Provider

安装当前provider:ugv完整依赖，至少涵盖：
ugv_execution、ugv_execution_command_ack、ugv_mutation_journal、
ugv_device_tool_call、ugv_state_snapshot、ugv_business_event_source_state/log。

Task、Execution、Dispatch完整arguments/context/result/payload保留。
不要只保留Hash，不能把源业务字段扁平化后丢弃实际请求。
原生downstream_mission_ids只作Execution汇总，不可替代逐派发Mission关联。

## SDAR

遵循当前真实安装入口选取“baseline + 未被baseline覆盖的增量”。
不得“baseline + 所有历史up.sql”重复安装；不得应用down.sql。
实际依赖包括Task/Goal/Plan/Workflow/Node/Skill输入、Invocation、Remote Task Binding及必要结果/证据/事务表。
共享知识、Skill、Workflow模板等是业务域级记录，不按device复制。
如果整个当前运行库为启动/事务所必需，应安装其当前依赖闭包，不另造缩水版。
不搭建独立Node Control管理系统，不搬迁聊天UI或其他系统。

## 源码托管与安装转换

GOWM新增：
```
database/shared-business-storage/
├─ sources.json
├─ upstream/
│  ├─ smpp-runtime/
│  ├─ ugv-provider/
│  └─ sdar-runtime/
├─ transforms/                 明确、可追踪的托管安装变换
├─ generated/
│  ├─ ugv_smpp/
│  └─ ugv_sdar/
├─ overlays/                   device scope / FK / indexes / key changes
└─ install-manifest.json
```

保留来源commit、完整原文件路径、规范化换行前后Hash定义；生成物记录每项变换。不要嵌入所有上游项目源代码。
禁止启动时联网“拉最新SQL”。Codex实施时对账一次后生成当前可重复安装包；后续升级再显式更新。

SDAR已知baseline含public.*、set_config(search_path,'')、函数、序列和vector。
转换必须按对象清单处理：
- 应用表/函数/序列/外键/默认值进入ugv_sdar。
- 扩展仍在既有受管理扩展Schema，不搬移或伪造vector/PostGIS。
- 函数体中未限定的应用表引用必须绑定正确Schema。
- 修正会覆盖安装连接search_path的语句。
- 支持当前实际PostgreSQL版本，不强制升级到最新；处理dump中的版本专用SET选项时记录为何可安全忽略。
禁止全文件简单replace("public.","ugv_sdar.")，它会误处理扩展对象且遗漏动态SQL。
源DO块/函数体内对象引用也必须验证；仅AST解析通过不等于正确安装。

## 迁移记账

1. GOWM公共9张表用下一可用core迁移；不写死076、不得重写旧001–075或当前更长历史。
2. 原生托管迁移使用独立安装入口，不塞进core数字序列。
3. ugv_smpp中迁移family分别为SMPP_RUNTIME和UGV_PROVIDER；版本身份为family+完整源文件名。
4. 保留源应用自身marker需要时的等价含义，不能让其与public.schema_migration互相误用。
5. 当前SMPP已知有两份合法014源文件，不能仅用数字编号去重。
6. 安装器拥有托管结构升级责任，应用后续以verify-only/migration-disabled模式接入。
7. 固定Schema安装一次；第三台设备加入只加数据，migration count不变。
8. 重复安装同一内容返回ALREADY_APPLIED；内容不同但同身份必须报错，不静默跳过。
9. 每个阶段的DDL与自身history写入事务化；原生SQL自带BEGIN/COMMIT时先生成清晰事务边界，不使用无效嵌套事务伪称原子。
10. 使用一个固定安装锁避免两个安装器并发冲突；这不是逐实例业务库管理。

## 依赖与既有GOWM隔离

基础依赖以现有GOWM为准。SDAR vector不可用时应报告准确依赖缺口，不删掉向量表、降级成JSON或假PASS。
core公共表与ugv_smpp可独立完成安装；ugv_sdar依赖失败不会导致已有GOWM服务/采集失效。
全套最终storage-ready需要SDAR安装及读写实测完成。

不得通过关闭约束、复制空表、禁用已有测试或临时表替代真实依赖。
安装连接的search_path与DDL显式限定相互一致；不能更改全数据库或所有角色的默认search_path。
extensions只在明确需要时安装，不移动/删除既有扩展，不修改旧业务数据。
