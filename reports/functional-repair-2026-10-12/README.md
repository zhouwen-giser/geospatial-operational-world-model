# GOWM 功能修复交付记录（2026-10-12）

R0–R5 已完成本地实施和部署包验证，正式迁移头为 **089**。
基线提交为 `506315b5a60e5f5fe405f020f61cec24be0be47d`；修复在当前工作区，尚未提交或推送。
没有连接或修改 sz-gowm，没有改动其他仓库，也没有恢复耗尽请求。

## 修复结果

| 项目 | 已落实的行为 |
| --- | --- |
| F01 默认范围 | 新模板的 UGV、Gateway、World API 使用 `default`；显式冲突前置失败，已有配置不改名或搬迁；保留 H3 单范围保护。 |
| F02 正式账号权限 | 087 和新的 `business_api_v2.sql` 以原登录身份授权设备接纳、目标、Mission、跨域关联及查询；两个实际业务账号通过接入验证，不再依赖管理员代调用。 |
| F03 服务接线 | 六项服务变量进入实际 Compose 配置；不完整组失败，缺服务配置如实为 `NOT_CONFIGURED`，`ready` 模式要求两个消费者都就绪。 |
| C01 自动原生安装 | 默认新安装先执行两个固定 schema 的正式 native SQL，再初始化账号和设备；数据库镜像加入锁定来源、许可证及 SBOM 的 pgvector。未知非空 schema 拒绝接管，既有密码只核验。 |
| F04 轨迹分析 | REST/MCP 共用 088 的版本固定读口，距离和停留按实际 segment 计算；不跨真实缺口推断运动或停留。缺投影返回 PENDING/503，多会话未选择返回 409。 |
| F05 SSE 恢复 | 089 用已提交事件的待追加项和范围计数行锁建立持久交付位置；支持分页、超过 10,000 条、低版本晚提交、重连、过滤器校验和有限背压。 |

新增 087–089 和 v2 overlay。旧 001–086 与已发布 **226 个 native/overlay SQL 文件**按旧部署包字节冻结，检查通过。
固定共享 `ugv_smpp`、`ugv_sdar` 和显式 `device_id` 保持不变；未新增实例级库、business_store 或导出同步链。
原事件、旧快照、旧轨迹/分析和既有设备/服务绑定不改写；重置 COMPLETE 策略、真实缺口及 PROVISIONAL 语义保留。

## 验证证据

| 验证 | 结果和范围 | 证据 |
| --- | --- | --- |
| 静态及类型 | `npm run check`、最终根类型检查通过；静态语义检查不要求重新取得既有 Stable 黑盒证明，不能据此宣称正式资格。 | `../functional-repair-check-retry.log`、`../functional-repair-typecheck-final.log` |
| 相关单元与兼容检查 | 8 个文件、45 项通过；另有数据库镜像单元检查 4 项通过，结果在工具执行记录。 | `../functional-repair-unit.log`、`tests/platform/gowm-v05-database-image.test.ts` |
| 实际 Compose | 三份正式 Compose 文件、实际 profile 组合解析通过；六项变量、范围、初始化依赖、私密配置复用、reset_ack 策略均检查。 | [compose.json](compose.json) |
| 真实 PostgreSQL | 全新安装和 086 保留升级分别通过 15 项功能用例及 42 项 native SDK 回归；不是现场或真实派发验收。 | [postgres.json](postgres.json)、`../functional-repair-ci-run.log` |
| 安装保护与保留升级 | 全新库未知非空 schema 拒绝；初始化重入不增主档/业务流；旧对象、事件、绑定和密码摘要在窄升级前后相同。 | `validation/scripts/functional-repair-e2e.ts`、`validation/scripts/functional-repair-ci.ts` |
| 业务账号边界 | 实际 SMPP/SDAR 登录完成并发首次接纳、只读验证、双设备目标/Mission/lineage；伪造 scope/GUC、角色切换提权、直接改主档、错设备 owner 等被拒绝。 | [postgres.json](postgres.json) |
| 轨迹与 SSE | 一小时/约 85km 缺口不累计距离或停留；REST/MCP 同版本；迟到修订不改旧摘要；12,001 条同版本回放、并发追加、晚提交/回滚、HTTP 重连与背压清理通过。 | [postgres.json](postgres.json) |
| 镜像 | 应用镜像 821 个源码文件与独立包上下文一致，45 个模块具有源码/编译摘要绑定，非 root 入口检查通过；数据库镜像构建成功，最终 vector 二进制与集成测试镜像摘要相同。 | [delivery.json](delivery.json)、`../functional-repair-package-final.log`、`../functional-repair-db-image.log` |
| 部署包 | 入口、权限、内部/外部校验和、排除规则和二次打包字节一致性通过；最终包包含当前 CI 用例、工作流和完成记录。 | [delivery.json](delivery.json)、`../functional-repair-package-final.log` |

首次静态检查停在 Git 历史读取子进程；确认并终止本轮进程后，在允许的本地执行环境重跑通过，没有修改语义检查代码或跳过门禁。
新增功能数据库门禁已同时接入 PR required check 和 main exact-head 工作流；远端工作流尚未运行。
轨迹裁剪/重建 SQL、现场并发未改变，因此没有重复以前的大规模性能与无关业务检查。
仅本轮两个独占 PostgreSQL 容器及匿名卷已按任务标签核对并清理；其他容器、数据库和服务未操作。

## 交付与后续边界

- 最新包：`output/deployment/gowm-dev-server-0.7.1.tar.gz`；校验和及镜像标识见 [delivery.json](delivery.json)。
- 原始旧包保留在 `output/deployment/previous-gowm-dev-server-0.7.1.0yU6li/`，SHA-256 已重新核对；中间生成的包也保留。
- 全新安装及 086 窄升级/回退步骤见 `docs/FUNCTIONAL_REPAIR_2026_10.md`。保留升级不运行账号/设备初始化、不替换数据库容器或卷、不提升并发、不恢复旧队列。
- SSE 使用 250ms 有界数据库轮询；保留原 MQTT 发布和 NOTIFY，broker 唤醒优化延期，不把 broker 可用性作为 SSE 前提。
- 原生域账号仍是受信运行账号，本次没有宣称原生全表已完成全面 RLS；缺服务配置不等于业务就绪。
- 现场部署、跨仓 Task→Execution→Mission 闭环、SACS→WSGS 业务验收及 exact-head 正式资格均为 **NOT_RUN**。
- M1–M6：真实跨仓闭环、完整 Artifact、可靠设备时钟、通用采集/多范围 H3、高级分析、生产 HA，仍是后续独立里程碑。

本报告和普通测试资料不进入部署包，防止包含本地运行证据或私密配置。
