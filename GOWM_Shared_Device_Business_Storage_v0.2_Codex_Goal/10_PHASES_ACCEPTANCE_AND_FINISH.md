# G10 — 阶段、验收与结束条件

## 顺序

P0 基线与源盘点：
记录当前HEAD/安装入口/原生表依赖/共享范围风险。
输出真实table inventory和key inventory。

P1 合同收口：
在GOWM提交当前共享数据布局、9张公共表、固定Schema、ID范围、安装与读写契约。
这是代码内的短暂收口阶段，不等待用户另行签字；后续实现遵守同一合同。

P2 公共设备表与配置访问：
实现4张设备公共表、Scope检查、服务绑定替换、MQTT路由解析纯函数。

P3 共享原生业务安装：
实际生成并安装ugv_smpp、ugv_sdar，隔离原生迁移family和GOWM核心迁移，处理public对象/函数/扩展。
必须是完整执行依赖，不是空Schema或几张缩略表。

P4 共享设备overlay：
实际落库device scope列、FK/unique、Idempotency、Snapshot、Cursor/Claim所需键与Query接口。
不修改SMPP/SDAR源运行代码。

P5 目标与Mission：
实现2张目标表、3张Mission关联表及真实写入验证；保留异步未关联、重复回执和冲突语义。

P6 统一查询和双设备验证：
固定只读查询、完整链正反查、同库双设备、事务、并发、scope回归。

P7 交接和交付：
更新文档、命令、`.env.example`（只示例）、来源清单、实际结果报告；提交GOWM功能分支。
用户授予仓库写入环境时push并创建GOWM Draft PR；不merge、tag、release。
推送/PR失败只标记交付状态，不把已验证存储功能判为失败，也不能伪造PR链接。

## Required Commands

现有基线：
```
npm run check
npm run build
npm test
npm run verify:sql
```

新增：
```
npm run business-storage:check
npm run business-storage:install -- --help
npm run business-storage:fixture -- --help
npm run business-storage:handoff
npm run business-storage:test:postgres
```

其中最后一项需要真实隔离PostgreSQL。可对同一测试DB执行install/verify验证完整流程。
如果测试环境没有数据库/必要扩展，其他工作继续，记录明确NOT_RUN，不能以Mock替代storage-ready。
不要求Docker、设备、WSGS、SACS真实联调；不要求HA/压测/灾备。

## 完成标志

所有必需实现、静态/回归与真实数据库测试都通过：
```
GOWM_DEVICE_SHARED_BUSINESS_STORAGE_DEV_READY
```

代码与无外部依赖检查完成，但真实PostgreSQL未运行：
```
GOWM_DEVICE_SHARED_BUSINESS_STORAGE_SOURCE_READY
POSTGRES_VALIDATION_NOT_RUN
```

有必须功能、迁移、静态或数据库行为测试失败/未实现：
```
GOWM_DEVICE_SHARED_BUSINESS_STORAGE_INCOMPLETE
```

这三个状态互斥。不把SOURCE_READY写成部分DEV_READY。
SMPP/SDAR应用是否完成后续接线，始终另列：
```
SMPP_RUNTIME_ADAPTATION_NOT_PERFORMED
SDAR_RUNTIME_ADAPTATION_NOT_PERFORMED
LIVE_MQTT_SWITCHOVER_NOT_PERFORMED
```

## Required验收的核心

- 仅改GOWM；最新用户共享库方案优先。
- 固定两个共享业务Schema，9张公共业务表；没有业务storeId和实例Schema。
- 完整原生业务依赖可安装，重复安装无重复DDL，既有GOWM不受破坏。
- device_id有明确来源，不存在全库ugv1默认或按进程推断历史设备。
- Scope、设备父子关系、稳定主键、来源命名空间正确。
- Snapshot/Idempotency/Cursor/Claim适合双设备共享，不只新增列。
- 目标精确修订与原始坐标保留，实际派发目标不漂移。
- Mission在明确设备+来源范围内关联，未知/冲突不假合并。
- 真正的Task–Step Run–MCP–Execution–Dispatch–Mission正反查通过。
- 正式交付DDL与可测试数据接口，不只提交设计文档。
- 交接说明准确区分storage ready和消费者runtime ready。
