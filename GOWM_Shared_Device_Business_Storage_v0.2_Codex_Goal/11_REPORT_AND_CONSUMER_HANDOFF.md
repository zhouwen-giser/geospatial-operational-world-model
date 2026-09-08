# G11 — 最终报告与消费者交接

## 报告文件

`reports/device-shared-business-storage-v0.2/FINAL_REPORT.md` 和同名JSON。

必须包含：
1. Scope：实际只修改的仓库，未触及的消费者。
2. 实际base/head、源SMPP/SDAR commit与安装入口。
3. 旧设计替换情况：business_store、实例Schema、store FK的处置。
4. 实际新增9张公共表及物理名；如等价复用，说明对应。
5. ugv_smpp/ugv_sdar安装对象数、依赖、迁移family、转换清单。
6. `device-scope-key-inventory.json`的逐项结果，尤其claim/idempotency/snapshot/lease。
7. 图形与Mission验证的实际结果。
8. 所有执行命令及退出码/测试数，未运行原因。
9. 是否真实访问隔离PostgreSQL、扩展版本、测试数据库脱敏标识。
10. 双设备正反向查询的输出摘要；Fixture说明。
11. 不兼容旧Repository的字段/索引变更及消费者后续位置。
12. 真实应用接线、旧数据迁移、MQTT切换均NOT_PERFORMED。
13. 实际branch/commit及Draft PR状态；不能制造链接。
14. 最终标志与剩余事项。

报告不得写入连接串密码、完整认证头或真实敏感配置。
不要求exact-head发布资格链、重复签名清单或Native Analysis Handoff。

## 建议JSON

{
  "taskId": "gowm-device-shared-business-storage-v0.2",
  "decision": "DEV_READY | SOURCE_READY | INCOMPLETE",
  "implementation": {
    "targetRepositoryOnly": true,
    "fixedSchemas": ["ugv_smpp", "ugv_sdar"],
    "instanceScopedBusinessStores": false,
    "deviceRootOwnershipImplemented": true,
    "sourceRepositoryAppsModified": false
  },
  "sources": {},
  "publicTables": [],
  "nativeDomains": {
    "ugv_smpp": {"install": "PASS | FAIL | NOT_RUN"},
    "ugv_sdar": {"install": "PASS | FAIL | NOT_RUN"}
  },
  "verification": {
    "static": "PASS | FAIL",
    "postgres": "PASS | FAIL | NOT_RUN",
    "dualDevice": "PASS | FAIL | NOT_RUN",
    "forwardReverseLineage": "PASS | FAIL | NOT_RUN"
  },
  "consumerReadiness": {
    "smppRuntime": "NOT_ADAPTED",
    "sdarRuntime": "NOT_ADAPTED",
    "mqttIngest": "NOT_SWITCHED"
  },
  "requiredAcceptance": [],
  "remainingIssues": [],
  "delivery": {"commit": null, "draftPr": null},
  "finalMarker": "..."
}

该JSON是本任务报告模板，不是任何OpenAI/Codex产品官方格式。

## 消费者交接包最少内容

```
shared-business-storage-handoff/
  storage-contract.json
  data-dictionary.md
  device-scope-key-inventory.json
  namespace-transform-map.json
  read-model-mapping.json
  repository-adaptation-matrix.md
  connection-examples.env
  dual-device-fixture-description.md
  smpp-handoff.md
  sdar-handoff.md
  mqtt-ingest-handoff.md
  verification-summary.json
```

SMPP/SDAR开发可在冻结的同一合同上分别开展，不需要边写边改GOWM字段。
若后续运行发现合同确有问题，应独立提交小型修订，不让实现者绕过device范围或新增实例Schema。

## 最终答复格式

说明：
- 完成了哪些共享表和读取功能。
- 真正验证过哪些内容。
- 哪些内容未运行。
- 后续消费端必须改哪些最小接点。
- 分支、提交、Draft PR真实状态。
- 一个正确的最终标志。

不能以“已入GOWM数据库”描述只生成SQL的情况。
不能以“全链路贯通”描述只完成GOWM存储Fixture的情况。
