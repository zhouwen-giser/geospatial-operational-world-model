# 本轮能力落地与交付

状态：**LOCAL_CAPABILITY_CANDIDATE_VERIFIED**，仅修改 GOWM。源基线 HEAD 为 `506315b5a60e5f5fe405f020f61cec24be0be47d`，交付包含当前工作区改动，不能当作该提交的 exact-head 正式资格。未更新 sz-gowm，未恢复耗尽队列，未修改其他仓库或现场绑定、密码、数据库和卷。

## 已落实

| 内容 | 实际交付与证据 |
| --- | --- |
| 090 完整历史轨迹 | 独立 PREVIEW open/read 能力、严格消费锁、不可变版本、NDJSON 分页/摘要/TTL、范围与冻结评估约束；旧预览合同不改 |
| 091 多范围态势 | 从实际已投影观测回填，按 scope 更新 H3 cell/observer；当前对象移动、类型、删除/恢复触发计数；同 cell 双范围互不混入 |
| 092/093 采集配置与时间 | 严格版本化 ROS2_UGV_7_V1 profile、流启停/QoS/注册 CRS、显式物理来源 opt-in、两锚点校准、冻结会话与显式切换、源时间 reset 水位 |
| 运维入口 | 可选 HTTPS/mTLS、认证 MQTT 八主题 ACL、独立设备 broker 出站路由、只读范围诊断、一致逻辑备份和真实隔离恢复 |
| 安装与分仓交接 | 全新自动安装至 093、089 窄升级；严格区分旧 native 与新增核心对象结构，未知字段仍拒绝；核对 SMPP/SDAR、分析仓与仿真 UI 的实际剩余接线 |

## 已执行验证

- [postgres.json](postgres.json)：全新 001–093 和 089 保留升级均通过。完整轨迹用例为 605 节点、4 页，逐页及总摘要通过；缺口保持、错误范围/版本/快照/TTL/权限拒绝、旧结果 hash 不变。
- 同一门禁额外启动真实 Gateway 和 Provider HTTP，保存预览 effectiveSnapshotManifest，使用 PINNED 进行 open、等待真实工作器评估、换幂等键取回，并读取全部四页（125764 字节、11 个冻结资源 pin）。Gateway 协调 store 在该用例中为内存，轨迹/评估/Artifact 事实为 PostgreSQL；不据此声明 Gateway 重启持久性。
- 同一 PostgreSQL 门禁验证双范围 H3、真实采集只读角色、持久 inbox→outbox→观测、校准 reset 水位、profile 激活/关闭/重连/旧 mapper 兼容，以及实际同版本 pg_dump/pg_restore、表计数/抽样 hash/owner/ACL 和拒绝非空目标。
- [既有功能回归](../functional-repair-2026-10-12/postgres.json)：全新及 086 保留升级分别通过 15 项真实 PostgreSQL/REST/MCP/SSE 用例和 42 项 native SDK 场景；原记录、绑定和账号密码保持。
- 根静态/类型检查、SQL AST、消费者双次构建通过；相关 14 文件 80 项回归通过。订阅逻辑调整后的 2 文件 5 项复核通过，含重叠测试，不相加为独立测试总数。
- [MQTT 安全](mqtt-security.json) 和 [生产 Compose](production-compose.json)：实际 TLS broker 覆盖七条业务主题及 reset_ack；错误凭据/不可信 TLS/越权写拒绝。生产 overlay 仅发布 8443/8883，保留卷身份、Gateway 授权，独立挂载 secret 和设备 broker 出站网络。
- 新增门禁接入 PR/main CI；本轮没有远程 GitHub exact-head 运行结果。本地构建日志位于上级 reports 的 capability-*.log。

## 最新部署包

[gowm-dev-server-0.7.1.tar.gz](../../output/deployment/gowm-dev-server-0.7.1.tar.gz)，SHA-256：

`1f5dd4002c6d480148b0b86e04c6899b1f3caf53b097d424cc2a37758529d8c6`

包包含 093 迁移头、68 个编译源码身份记录、16 个 Provider / 126 个能力。独立解压上下文与镜像的 841 个文件摘要及全部编译模块身份一致；非 root 入口、校验和、排除项和字节可重复归档通过。镜像为 `gowm-dev-package-check:1f5dd4002c6d4801`，ID 与详情见 [delivery.json](delivery.json)。原 `2b152714…` 包及中间包均保留；报告、真实凭据和测试目录不进入包。

升级及调用说明：[能力交付](../../docs/CAPABILITY_COMPLETION_2026_10.md)、[运维](../../docs/PRODUCTION_OPERATIONS.md)、[分仓接入](../../docs/CAPABILITY_INTEGRATION_HANDOFF.md)。保留数据升级不得运行账号或设备初始化。

## 未完成边界

实车校准证据与业务验收、SMPP/SDAR 受控写接口分仓适配、SACS→WSGS 正常业务闭环、仿真 UI reset_ack 仍未验收或需要对应仓修改。相邻分析仓已有三类算法，不在 GOWM 重复实现；本地源码核对见 [adjacent-source-audit.json](adjacent-source-audit.json)。

WAL/PITR、HA、实际 RPO/RTO、长期容量和任意厂商 adapter 仍未实现/未取得资格。逻辑恢复和本地 TLS 用例不能替代这些项目。镜像依赖安装仍记录既有 npm 审计告警，本轮未执行依赖升级或审计整改。旧单模块 JSON 和 native-structure-diff.json 是开发期诊断记录；最终判断以上述汇总门禁和 delivery.json 为准。

本次临时 PostgreSQL 容器及匿名卷已按任务标签清理；临时 MQTT 容器由测试清理。验证镜像和旧包保留，没有操作共享或现场资源。
