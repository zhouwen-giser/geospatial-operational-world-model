# GOWM 设备中心化共享业务存储 v0.2 — Codex Goal任务包

目标仓库：`zhouwen-giser/geospatial-operational-world-model`  
生成日期：2026-09-08  
任务性质：GOWM单仓实现；其他仓库只读。`v0.2`是任务设计修订，不是GOWM根软件版本。

## 入口

将本目录放在GOWM工作区可读取的位置。
把 `CODEX_MASTER_PROMPT.md` 全文交给Codex，或让其先读取该文件，再读取 `FULL_CN.md`。
不要只执行旧v0.1 SQL，不要只输出设计文档。

## 固定目标

- 所有UGV共享`ugv_smpp`和`ugv_sdar`两个业务Schema。
- `device_id`是业务归属，Worker/进程是处理者，两者解耦。
- 9张公共业务表，保留现有GOWM对象/观测与原生Task/Workflow/MCP数据。
- 不再创建按实例的`business_store`、动态业务Schema和`*_store_id`关系。
- 真正检验Snapshot、Idempotency、Cursor、Lease和Task Claim的设备范围。
- 同一套表完成两设备Task→Mission正向/反向查询。
- 不导出采集SDAR/SMPP业务副本，不实施消费者运行改造或设备控制。

## 文件

- CODEX_MASTER_PROMPT.md：执行入口。
- FULL_CN.md：完整单文件任务书。
- 00—11：拆分实施要求。
- SOURCE_EVIDENCE.md：本轮读取来源与未验证边界。
- task.json：本地任务元数据，不是Codex官方配置。
- data-model-contract.json：固定布局、9表和状态规则。
- schemas/data-model-contract.schema.json：任务数据模型清单自身的格式校验。
- acceptance.json：40项验收。
- test-scenarios.json：36个功能场景。
- examples/：仅示意双设备和配置，不是可直接执行的数据库Fixture。
- scripts/verify_package.py：仅校验任务包文件完整性和清单，不执行项目测试。
- PACKAGE_MANIFEST.json、SHA256SUMS.txt：完整性记录。

## 校验任务包

```
python3 scripts/verify_package.py
```

## 实施完成状态

`GOWM_DEVICE_SHARED_BUSINESS_STORAGE_DEV_READY` 需要真实PostgreSQL验证。
缺DB时只能 `GOWM_DEVICE_SHARED_BUSINESS_STORAGE_SOURCE_READY`。
源代码或必需功能未完则 `GOWM_DEVICE_SHARED_BUSINESS_STORAGE_INCOMPLETE`。

即使storage DEV_READY，也不意味着SMPP/SDAR应用已经适配或真实MQTT已切换。
