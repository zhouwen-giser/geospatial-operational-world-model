# sz-gowm 热更新记录（2026-09-09）

于约 15:22–15:27（Asia/Shanghai）完成现有 GOWM 的定向热更新。

- 包 SHA256：`64760748270d1e522c6eb4b3b04da8a38d1f80c99fcac89d54bcd9161e28175c`
- 已验证镜像：`gowm-dev-package-check:64760748270d1e52`
- 镜像 ID：`sha256:abecf17c94538b76f851679e3068fdb97c06acaba829ec9caa8d137c4159a8e8`
- 远端交付及审计目录：`/mnt/data/gowm-history-releases/64760748270d1e52/`
- 当前部署根目录：`/mnt/data/gowm-analysis-releases/341a14aceee94a4a/gowm-gdps-analysis-dev-server-0.1.0`
- Compose 项目：`gowm-analysis-dev-d2bf0ea98e`

仅更新 projection-worker、world-platform-projection-worker、ugv-mqtt-ingest、history-auto 四个容器。使用明确服务名和 `--no-deps --no-build`；未执行完整安装器、初始化、清理或队列恢复。现有 build-compat.compose.json 仅增加这四个服务的新镜像及构建来源，其他服务配置保留。

追加执行正式 083 迁移并将迁移账本写入同一事务；执行前核对全部既有迁移校验和。没有执行通用迁移器后附的密码设置流程，没有重置数据库账号。原数据库容器及 `gowm-plus-db:sdar-pgvector-runtime-0.8.5` 镜像保持原样。

## 现场核对

- 其余 68 个容器（包括已退出的初始化容器）的 ID、镜像和启动时间均未变化。
- 四个目标容器有效环境变量、挂载、网络、命令和 Compose 声明的依赖关系保持一致。`--no-deps` 导致重建容器的 Compose depends_on 运行标签为空，因此依赖检查使用未变更的 Compose 声明；未触发依赖容器操作。
- 环境文件摘要、设备主档、MQTT 端点、采集流、服务绑定摘要和所有既有 PostgreSQL 角色密码摘要核对一致。
- 两个投影工作器输出 ready，采集和自动调度容器 healthy。
- 采集 readiness HTTP 200；原持久 MQTT 会话恢复（session_present=1）。
- 原七条业务订阅及新增 `/sim/reset_ack` 均获 QoS 1 订阅确认；lastError=null。
- 现场消息持续接收/落库；采样时 inbox/outbox pending 均为 0。
- 原死信总数 8；083 安装后新接收的消息中死信为 0。未恢复现场旧失败队列或死信。
- 未重复运行已完成的测试；未发送仿真重置命令验证回执，也未伪造完整水位。

## 回滚资料

远端 `override.before.json` 保存原覆盖文件，`baseline.json` 保存容器及配置摘要，`verification.txt` 保存核对结论。旧镜像未删除。必要时恢复原覆盖文件，并只定向重建上述四个服务；083 为追加迁移，回滚运行镜像时保留迁移及证据数据，禁止删除数据库或卷。不得使用完整 compose down、remove-orphans 或 prune。
