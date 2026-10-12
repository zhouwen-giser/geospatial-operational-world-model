# 2026-10 功能修复与安装交接

本文记录先前 F01–F05、迁移 **089** 的交付。当前迁移头为 **093**，追加能力、范围约束与分阶段升级以 [后续交付说明](CAPABILITY_COMPLETION_2026_10.md) 为准。交付仍是开发部署候选。
本地 PostgreSQL、REST/MCP、镜像及包验证不等于 sz-gowm 验收或 exact-head 正式资格。
不修改其他仓库，不恢复耗尽队列，不回填历史事件。

## 全新安装

执行 `scripts/dev-deploy.sh init`，填写真实 `UGV_MQTT_URL`，再执行 `up`。
默认采集、Gateway 和 World API 范围均为 `default`，保留该范围原有 TEST 分类。
默认值仅补缺；已有显式范围、来源、世界对象和密码不改名、不搬迁。
UGV 与 Gateway 范围冲突会前置报错。091 已落地范围内 H3 投影，设备检查校验新读口及部署授权范围，不再要求整个数据库只有一个范围；不得删除范围绕过隔离。

自动顺序：配置检查 → 核心迁移 → 正式 native SQL/overlay → 两个业务账号 →
设备主档、MQTT 端点、七条业务流及服务授权 → 管理员只读检查 →
**两个实际数据库登录账号的只读检查** → 启动 MQTT 采集。
`/sim/reset_ack` 是独立控制订阅，七条业务流不改变；继续沿用
`RESET_ACK_ACCEPTED_COMPLETE_V1` 的允许少量丢包与迟到策略。

| `GOWM_BUSINESS_INSTALL_MODE` | 行为 | 业务就绪含义 |
| --- | --- | --- |
| `storage`（默认） | 安装两个固定共享 schema 的正式表及独立账号 | 缺服务标识时为 `NOT_CONFIGURED` |
| `ingest` | 配置采集和账号，跳过 native 安装 | native 为 `DISABLED`，业务就绪为 false |
| `ready` | 安装正式存储并校验 SMPP、SDAR 绑定及实际账号 | 必须提供完整服务标识，缺少任何组都失败 |

SMPP 成组填写 `SMPP_SERVICE_KEY / UGV_PROVIDER_ID / UGV_RESOURCE_ID`；
SDAR 成组填写 `SDAR_SERVICE_KEY / SDAR_MCP_SERVER_ID`，可附 `SDAR_AGENT_PROFILE_ID`。
标识必须来自实际服务配置；未配置时不生成假服务或假绑定。

数据库账号为 `ugv_smpp_app`、`ugv_sdar_app`。随机初始密码和连接配置在
`.runtime/dev-deploy/business-connections.env`，权限 0600，不进入包或输出。
重复初始化只核验原密码。未知账号、未知非空 schema、账本或摘要冲突拒绝接管。
数据库镜像提供锁定来源摘要的 pgvector 0.8.6、许可证与 SBOM；仅新安装显式创建扩展。
已有扩展检查 namespace、版本记录和 `vector_dims` 能力，不自动升级或移动扩展。

## 正式业务账号接口

继续使用同一 GOWM PostgreSQL 中的 `ugv_smpp`、`ugv_sdar`。不创建实例级库、
`business_store`、全局默认 device_id 或数据导出同步链。
管理员用 `authorizeBusinessServices(client, serviceInput, allowedDeviceIds)` 配置授权。
087 对已有受管账号和有效绑定建立对应授权，不改绑定或密码；
无既有绑定时必须显式配置授权，运行账号不能自行授权。

运行账号在自己的事务中调用 `resolveBusinessDeviceContext(client, input, 'admit')`，
使用返回的 `deviceId / bindingId / actorReferenceKey`；只读验证用 `'verify'`。
外部标识 `ugv`、主档 ID `ugv:ugv`、正式 `wrf_*` 引用不能自行拼接替换。
已有绑定优先；没有显式设备或绑定时仅允许范围内唯一启用主档。
即使授权集合只有一个设备，范围内有第二台设备仍报告歧义。

受控函数以 `SESSION_USER` 校验授权，不信任范围 GUC，不因 SET ROLE 扩大权限。
专用所有者 `gowm_business_api_owner` 为 NOLOGIN，业务账号不获得其成员资格，
也不获得主档、绑定、目标或 Mission 的全表写权限。
原生域账号仍是受信运行账号，对自己的原生表有 DML；本次不声称已实现全面 RLS。

SDK 的目标创建、owner 关联、Mission、Execution 关联、SDAR canonical MCP 身份及
统一读取使用受控 API。运行时 `createTarget` 必须显式传 `deviceId`。
跨域 owner、跨设备、错误服务或不完整 owner key 被拒绝。
`resolveRemoteTask` 只验证真实协议回执的身份，不能用插表代替 MCP 派发。
SMPP、SDAR 消费者仍需分仓适配；GOWM fixture 不代表真实业务闭环。

## 缺口感知的兼容轨迹

REST `track / recent / stops / route-deviation` 和 MCP `get_object_track` 共用 088 读口，
在一致读取中固定当前不可变 tracklet 版本，只读该版本引用的原始证据。
同一对象多个来源、会话或分析空间有交集时返回 409；通过 `source / trackerSessionKey /
analysisSpaceKey / profileKey` 明确选择。范围来自部署配置，不把自报范围当作认证。

距离只累计同一 segment 内的相邻证据；缺口切断停留候选和分析窗口。
未知覆盖不推断为完整。identity 指向实际 tracklet 版本及内容摘要，
MCP 不再用当前世界对象版本证明历史输入。

`track` 保留 representation、points 和 summary，追加 identity、gaps、status、truncated、
`versionEvidenceSampleCount`、`coverageMeaning`。样本计数属于完整版本，
窗口内返回数量为 `summary.pointCount`；几何节点数不当证据数。
数组型旧入口保持数组，通过 `X-GOWM-Trajectory-Status / -Truncated / -Gap-Count` 和
`X-GOWM-Tracklet-Version` 提示状态。未投影返回 503，缺交集为 `NO_DATA`；
截断为 `PARTIAL`，不得解释为完整任务。旧轨迹、旧快照及旧分析不改写。

## SSE 恢复合同

089 为已提交 `world_event` 建立范围内持久交付索引，原事件公开字段不变。
事件事务只写待追加项；追加器通过范围计数行锁串行提交交付位置。
低 worldVersion 晚提交事件获得新位置，不会被版本高水位永久跳过。
迁移在建立触发器的表锁内登记旧事件，已 MQTT 发布的记录同样可回放。

工作器独立追加循环使用一个连接和独立退避；CORE、TRACKLET、FINALIZATION、HISTORY
执行槽和 `--once` 行为不变。SSE 默认每页 500、最多 1000 项，按 4 MiB 行序列化预算
缩小页；单帧超过 16 MiB 拒绝发送，背压最多 10 秒，15 秒心跳。
分页数不限制总回放量，没有无限 seen 集合，关闭时清理等待。

本轮采用 **250 ms 有界查库** 等待新交付项，使 SSE 不依赖 broker 连接成功。
MQTT 仍承担原有事件发布，NOTIFY 已发出供以后唤醒优化使用。
这是对计划中 MQTT 唤醒方式的实施调整，不影响持久索引的正确性。

客户端保存最后完整收到的 `id: eventId`，重连传 `Last-Event-ID`。
游标必须属于当前范围并匹配当前类型/区域过滤器：格式错误 400，未知或不匹配 410，
非部署范围 403；不会静默从最新位置开始。标准游标优先于 `sinceWorldVersion`。
没有标准游标时版本阈值只是筛选，不能证明提交前缀完整。
交付至少一次，客户端按 eventId 幂等；交付位置不是事件时间顺序。
本轮不清理事件和游标。

## 保留数据升级与回退

仅对已到 086 的库使用 `functional-repair-upgrade.js [--check]`。
它核对 001–086 和已有 native/overlay 摘要，只追加 087–089 和 `business_api_v2.sql`。
没有完整 native 安装时报告 `NOT_CONFIGURED`，不自动创建原生表。
不调用通用 migrate、账号、设备或默认绑定初始化，不轮换密码，不重建数据库容器或卷。

后续现场执行需另行授权。先确认旧包、数据库备份、容器所有权、现有网络/卷和依赖，
使用新包构建并校验的镜像，在既有 Compose 项目中串行执行：

1. 原管理员连接运行 `node dist/scripts/functional-repair-upgrade.js --check`，检查 pending 和 native 状态。
2. 去掉 `--check` 执行。核心迁移同事务提交；新 overlay 独立记账事务，失败后可重试。
3. 只更新 GOWM 投影工作器及 World API/MCP 等受影响服务，保持环境、并发、网络、卷和绑定。
   配置消费者后再只读运行 `runtime-verify.js`，不调用账号初始化。
4. 检查新事件追加、SSE 重连和指定来源/会话轨迹，观察队列及数据库压力。
   历史并发策略和 30 秒裁剪预算不变；不恢复耗尽请求、不清零尝试次数。

容器命令使用已审核的现有项目/服务名称及 `--no-deps`，不要用全项目 `up` 热更新。
本轮未执行现场步骤。迁移只向前；回退时保留追加对象及数据，先验证旧镜像与
新增触发器、授权、读口兼容，再恢复具体服务镜像，不删库、卷、账本或强改摘要。
旧消费者的严格结构校验需要识别 v2 overlay。

本地证据在源码仓库 `reports/functional-repair-2026-10-12/`；普通 fixture 和报告不进包。
M1–M6（真实跨仓闭环、Artifact、可靠时钟、通用采集/H3 多范围、高级分析、生产 HA）
仍是独立后续任务，不计为本次完成或 N/A。
