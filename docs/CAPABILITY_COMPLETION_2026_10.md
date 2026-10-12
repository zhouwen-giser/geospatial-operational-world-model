# 2026-10 后续能力交付

本轮仅修改 GOWM，正式迁移头推进到 **093**。001–089、原生业务 SQL 和旧历史查询/result/正式消费者 lock schema 保持字节不变。新能力为开发候选/PREVIEW，真实设备、跨仓业务验收和现场生产资格分别记录。

| 项目 | 本仓实现 | 验收边界 |
| --- | --- | --- |
| M2 完整轨迹 Artifact | 版本化 open/read、完整节点分页、摘要、范围/快照/评估固定、有效期 | 本地 PostgreSQL 与公开 Provider 协议验证；旧预览合同不扩大声明 |
| M3 校准与会话 | 两锚点 tick 校准、显式到达代理、不可变 profile、停收/排空/关闭/新建 | 校准用例证据是 TEST_FIXTURE_ONLY；实车时钟必须提供真实锚点 |
| M4 配置与多范围 H3 | ROS2_UGV_7_V1 配置合同、启停流/QoS/CRS 注册校验；多范围投影、回填、移动/删除/读取 | 新厂商载荷需专用 adapter；每个 Provider 实例仍只接受配置授权范围 |
| M6 本地运维 | 可选 HTTPS/mTLS、MQTT TLS/ACL、只读诊断、逻辑备份及隔离恢复 | 已验证逻辑恢复，不声明 WAL/PITR、HA、RPO/RTO 或现场容量通过 |
| M1/M5 分仓接入 | 核对当前相邻仓代码、明确 API 与读合同接线 | 见分仓说明；未修改其他仓或执行会产生设备动作的业务验收 |

## 090：完整历史轨迹

既有 `history.get-trajectory@1.0` 保持有界预览语义。新增：

- `history.open-trajectory-artifact@1.0`：input 为 `{request, trajectoryReferenceKey}`。`request` 必须是预览使用的**完整原查询**，包括 `maximumInlinePoints`；引用直接使用预览返回值。使用对应冻结 effective snapshot，不能把稍后的“最新查询”当作同一冻结输入。
- `history.read-trajectory-artifact@1.0`：input 为 `{artifactReference, pageNo}`。按 open 返回引用逐页读取，从 0 到 `pageCount-1`；`nextPage=null` 表示字节取回结束。

调用仍经正常 Gateway 身份、授权、查询快照与 Provider 协议。两项能力注册在原 Historical Provider，没有新事实库或业务同步链。独立消费锁为 `contracts/consumers/historical-trajectory-artifact-v1.json`；消费者包导出 `./trajectory-artifact-lock`。旧正式 historical lock 中的非声明保留，不能用本地证据改成正式资格。

Gateway 客户端保留预览响应的 `effectiveSnapshotManifest`，open/read 的 World Query 使用 `snapshotPolicy={mode:"PINNED",pinnedSnapshot:<该完整 manifest>,allowDowngrade:false}`，不重新生成 capturedAt、资源列表或 manifestHash。预览仍可为 PARTIAL，Artifact 取回不消除缺口。

首次 open 可能为该完整冻结 manifest 创建新的请求评估，返回 `PROJECTION_PENDING`。沿用现有 Gateway 合同，此时 World Query 为 FAILED，待处理原因保存在 `nodes[].result.output.value`，顶层 outputs 可能为空；这不等于 NO_DATA。等待正常工作器后，以新的 queryId/requestId/idempotencyKey 重试，保持上述 pinnedSnapshot、原始完整 request 和轨迹引用不变。不要重放已完成的旧 Gateway receipt 来等待结果变更。之后逐页 read 使用相容的冻结 manifest。该流程已由真实 Gateway→Provider HTTP 和 PostgreSQL 验证，测试中的 Gateway 协调 store 为内存；不将此项宣称为 Gateway 持久化/故障恢复资格。

open 必须找到与完整请求/快照匹配的 086 请求评估证明；没有证明时返回 `PROJECTION_PENDING` 并按正常队列处理。另一请求可以安全复用同内容旧轨迹，但必须有自己的评估/分析，不能直接复用别人的请求证明。错引用、错范围、版本或摘要冲突拒绝。

格式为 UTF-8 NDJSON：第 0 页是 manifest，后续每页最多 256 个几何控制节点，按 segment/node 排序。保留原 segment 的开闭边界、插值方法、节点、真实 gap 和 excluded period；独占右端的插值控制节点仍可能出现在字节中，解释有效时间必须看边界。坐标由 PostGIS GeoJSON precision 15 编码，时间为 UTC 微秒；不声称是 IEEE 浮点的无损二进制导出。`evidenceSampleCount` 是证据样本数，不能用 `geometryNodeCount` 代替。

消费者保存每页**原始 `content` UTF-8 字节**，先校验 `pageDigest`，再按页序连接；总长度须等于 `byteLength`，连接后 SHA-256 须等于 `artifactReference.digest`。不得重新 JSON 序列化、规范化空白或调整换行后再校验。manifest 中的轨迹 content hash、input set hash、完整请求 hash 与 snapshot hash 是不同身份，不能互相替代。

`READY` 只证明字节可读，不把 `PROVISIONAL/PENDING`、缺口或未封存改成完整。最多 250000 节点、64 MiB、1000 页；SQL 仍受 30 秒预算限制。超过预算返回明确错误。

`HISTORICAL_TRACE_ARTIFACT_TTL_SECONDS` 默认 86400，最高 604800。旧引用过期即不可读；重新 open 可以产生新的访问登记，但不会延长旧引用期限。登记和旧事实保留，不自动删除被快照/分析引用的数据。Provider 重放会重验 TTL；Gateway 已完成的幂等 receipt 是历史回执，重放不续期。过期后需要新的 Gateway 幂等键重新 open/read，仍须保留原冻结请求；不得将缓存的 READY 当成当前可访问证明。

读取请求的 effective snapshot 时间不得早于 Artifact 原冻结时间；其中明确固定的轨迹/输入/subject 版本和摘要必须相容。Artifact 身份仍绑定原冻结请求和快照，读取不会选择其他最新轨迹。

## 091：范围内 H3 投影

新 `gowm_situation.cell/observer` 的键包含 `data_scope_key`。迁移在短时表锁下，从已 projected/superseded、非 CANDIDATE 点观测回填观测/observer 统计，并重建当前对象计数。旧全局态势表保留，旧聚合数不当成可按范围拆分的证据。

`gowm_situation.cell_scored` 在事务中读取 `gowm.data_scope_key`，未设置时返回零行。运行读取账号只有视图权限；原全局视图权限撤销。每次 Repository 读取建立只读事务并设置范围，提交后连接池不保留范围。Provider 根据 `GOWM_SITUATION_ACCEPTED_DATA_SCOPE` 拒绝其他范围，库中存在第二个范围不再使全部态势能力失效。跨范围调用仍需分别配置授权实例或既有受控路由，不能任意自报范围。

新观测按自身范围更新。几何、对象类型、软删除/恢复和硬删除触发当前对象计数调整；历史观测计数不随对象删除减少。迟到观测保留最早/最晚 observer 时间。围栏投影只匹配同范围区域，不产生跨范围区域事件。

## 092/093：配置、校准与会话

profile 是严格 JSON 合同：`schemaVersion=1.0`、`adapter=ROS2_UGV_7_V1`，固定 scope/source/device/endpoint/worldEpoch/trackerSessionKey、源 schema lock SHA-256、已注册 analysisSpaceKey/SRID、originKind 和七条 routes。每条 route 明确 enabled、QoS、messageProfile 和 clock。

当前 adapter 仍解析既有七类 ROS2 UGV 载荷；topic 集合保持这七类合同，可禁用部分流。QoS 0 仅 speed，且另需 `UGV_MQTT_SPEED_QOS0_COMPAT=true`。profile 中的物理来源和已注册投影 CRS 是显式 opt-in；它们不使任意载荷或任意地理区域自动可用。缺少 active profile 时保留原 v3 仿真/到达代理路径。物理来源或非机场 CRS 必须显式设置 `UGV_RUNTIME_PROFILE_REQUIRED=true`，同时令环境中的 origin、analysis space/SRID 与已注册 active profile 一致；缺 profile 或配置冲突均拒绝启动。

clock 为显式 `ARRIVAL_PROXY`，或 `CALIBRATED`：

- TIME_US / CAPTURE_TIME_US 为微秒整数；ROS_STAMP 为 sec/nanosec 组合的纳秒。目标流使用每个目标的 capture_time_us。超过 JS 安全整数的数值必须提供合法整数文本，禁止经过不精确浮点恢复 tick。
- 两个递增锚点各含 tick、UTC 和校准 evidenceReference；同时固定单位、epoch/会话、有效 tick 范围、声明不确定度、最大漂移和漂移误差。有效范围最多七天。
- 采用两锚点仿射转换，输出模型版本、校准引用、漂移、不确定度和原 tick。大幅积压不把接收时间当作源时间。缺 tick、重置后超界、漂移不合法或来源/会话冲突明确失败；CALIBRATED 不静默降为代理。
- 093 只接受会话冻结且已正式注册的 profile/route 对应时钟。显式代理流和校准流分别校验。成功 reset_ack 仍推进到边界内已持久化观测的源时间，不使用回执服务器 ts 作为仿真时间。

profile 只能管理员显式注册/激活。运行采集账号读取配置，不创建主档、改绑定或写 profile。JSON 校验入口在 `runtime-profile.ts`，无需复制测试锚点到生产。

显式切换顺序（在获授权上线窗口操作）：

1. 用管理员连接 `node dist/scripts/ingest-profile.js register <private-profile.json>`。同版本重复注册幂等；不同内容冲突。
2. 配置 `UGV_INGEST_ADMIN_TOKEN_CONTAINER_FILE`，把相应至少 32 字符令牌文件只读挂载到容器。使用该令牌调用采集器 `POST /v1/ingest:quiesce`。端口只开放给管理员；默认无令牌时返回 403。它停止 MQTT 接收，继续已有 inbox/outbox 处理，不自动关闭持久会话。
3. 检查旧会话剩余 inbox/outbox；存在死信时先审计，不清零尝试、不伪造成功。使用 `close-session <scope> <session-uuid> <reason>`，必须已断开且无待处理消息。关闭不可撤销，旧身份和上下文摘要不变。
4. `activate <scope> <device-id> <profile-id> <version>`。任何相关未关闭会话都会阻止激活。新会话接纳与激活使用同一范围锁，并再次核对 active profile，拒绝启动前已过时配置。
5. 核对环境中的 scope/source/endpoint/epoch/session 与 profile；使用**新的 MQTT client ID**建立新 broker 会话。重启采集器，校验实际订阅的 QoS/启用流和 readiness。双设备继续使用独立会话。

已有 pending/retry 消息继续按各自持久化 mapper 上下文处理，v1/v2/v3 不回填或改时间。设备改名、绑定或 profile 变更不改变旧消息归属。

已只读复核本地仿真仓 c106205：`_reset_cmd_cb` 发布 ROS String reset_ack，bridge QoS 1；UI `/api/reset` 仅调用 reset_simulation，没有发布该回执。UI 重置不会触发 COMPLETE 策略，修复该出口仍属于仿真仓任务。本轮未向设备发送重置。

## 保留数据升级与回退

全新部署的通用 migrate 自动发现 001–093，默认设备和账号初始化顺序沿用既有安装器；不会自动注册校准或启用生产 overlay。

086 基线先按既有 `functional-repair-upgrade.js` 到 089。随后：

1. 保留环境、账号、网络、卷、依赖与旧包，确认备份和当前迁移账本。停止领取新投影任务，并等待两个工作器事务退出；无需停止数据库或其他项目。
2. 新镜像运行 `node dist/scripts/capability-completion-upgrade.js --check`。它校验 001–093 已有账本与源摘要，仅允许从 089 追加。
3. 使用 `--projection-workers-stopped` apply；该参数是操作方对工作器已停的显式声明，脚本不会替你停容器。091 会取得 canonical 表锁完成一致回填，锁超时会回滚，可排查后重试。090–093 与账本在同一事务提交，重复 apply 幂等。
4. 只更新 GOWM 投影工作器、Historical/Situation Provider 及受影响 API；使用原项目的指定服务 `--no-deps`，不运行通用 init/account/device 命令。采集 profile 如需切换，独立执行上节流程。
5. 检查指定范围、真实 actor、历史查询/完整 Artifact、队列和数据库压力。现场 SACS→WSGS 仍需正常业务路径验收，不用队列成功代替 Finding。

该窄升级不安装账号、不轮换密码、不创建设备、不激活 profile、不恢复耗尽请求。已有 093 之后不能重新调用仅接受 086–089 的旧窄升级；用对应阶段检查入口。

迁移只向前。回退保留新增对象和全部旧事实，停止新功能后恢复已验证兼容新 schema 的具体旧镜像。旧全局 H3 Provider 在权限撤销后不具备安全回退读口，不能临时恢复全局权限；保留新 scoped Provider 或停用态势查询。v4 会话不能交给只支持 v3 的旧采集镜像。其他容器、关联库和绑定不参与回退。

运维入口与恢复工具见 `PRODUCTION_OPERATIONS.md`；分仓实际差异见 `CAPABILITY_INTEGRATION_HANDOFF.md`。
