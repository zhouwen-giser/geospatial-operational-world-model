# 历史轨迹生成与重置回执水位

本包包含裁剪性能修复、历史调度在途控制及正式迁移 083。仅部署 GOWM，不修改 GDPS、GSAP、SMPP、SDAR 或仿真仓库。安装器沿用正式迁移发现机制，升级时保留所有已有迁移校验和。

## 查询数据范围

使用 `GOWM_DATABASE_URL=... node dist/scripts/history-diagnose.js default` 读取诊断。数据库客户端必须在同一事务中调用 `gowm_history_v1.set_data_scope('default')` 后查询有效视图；自动提交模式下单独设置不会延续到下一条 SQL。片段身份、片段版本、任务轨迹、封存数量含义不同，不应合并统计。

## 明确的业务策略

`RESET_ACK_ACCEPTED_COMPLETE_V1` 默认启用。成功重置回执被业务认可为允许丢包的完整性边界，追加 COMPLETE 水位；不代表无丢包保证，不补造采样，不删除缺口，也不伪造任务完成。开放任务及有其他未满足条件的片段仍可能 PROVISIONAL。

消息来源是仿真控制面板 `referee/dashboard/combined_dashboard.py` 的 `_reset_cmd_cb`，经 `ros2_mqtt_bridge` 的 `/sim/reset_ack` 发布。QoS 必须为 1，载荷接受 `{ok,target,ts}` 或 ROS String `{"data":"JSON字符串"}`。既有七条业务流不变，额外订阅的是控制回执。MQTT PUBACK 仍在持久化完成后发送；处理进程重启可继续处理。

固定默认外部设备标识 `ugv` 接受 `ugv/red/all`；其他设备须由部署管理员在 `gowm_history.reset_ack_policy(data_scope_key,device_id,targets)` 显式配置。策略表是部署配置，运行账号不得改写。scope、source、device、session、mapper context 和接收序列来自持久化接收记录。拒绝 retained 回执，回执 ts 早于会话创建或偏离接收时间超过 60 秒时不推进水位。

当前数据采用 `mqtt-arrival-proxy-v1 / ADAPTER_WALL_CLOCK` 时间模型。水位使用同会话回执之前的持久化观测的时间解末时间，不能使用回执 ts 替代仿真事件时间。其他时间模型记录 TIME_MODEL_UNSUPPORTED，需要单独实现转换。处理先等待旧 inbox/outbox 完成；无观测时保留待处理记录。初始 UNKNOWN 不会因服务启动自动改为 COMPLETE。

追加水位由 `gowm_history.process_reset_ack(client,broker)` 实施，调用前须在事务内设置匹配的数据范围。运行账号需要 `gowm_reset_ingest` 角色；现有管理员账号已具备权限。该角色只拥有受控函数权限，无业务表修改权限；普通历史读取账号不能调用。源事件 authority 共享多个设备时，不为整个 authority 写入单设备的 COMPLETE。

`reset_ack_evidence` 保存回执幂等键、摘要、会话、接收边界及允许丢包策略；`reset_ack_watermark_input` 记录追加水位及时间边界。同内容重复回执不产生新水位，冲突内容进入死信，已被更新回执超过的旧回执不回退水位。

迟到数据继续正常摄入，产生新的片段及历史修订；旧冻结查询与分析证据不改写。回执只界定时间前缀，不替换持久化采集会话身份。新会话按现有流程显式建立。当前面板 UI `/api/reset` 不发布 reset_ack，不能触发此策略；仿真仓库需要后续统一回执出口，本包不修改该仓库。

## 后续串行上线与积压处理

1. 与共享现场负责人协调，记录 GOWM 镜像、配置、迁移和队列状态，备份现有部署包；此交付不自动连接服务器。
2. 暂停 GOWM 历史调度与工作器，执行正式迁移，授予接收运行账号受控角色；保留数据库和数据卷。
3. 更新 GOWM MQTT 接收器、两个投影工作器及 history-auto，核对双方工作器镜像一致、原七条流和 reset_ack QoS 1 订阅成功。
4. 先验证一个新冻结请求能在 30 秒单 SQL 预算内完成，再观察超时与队列趋势。检查有效视图时显式设置范围。
5. 对已耗尽的旧请求，逐项记录 queue_id、请求/快照摘要、旧状态、代际、已用次数及恢复理由；另行实施明确次数预算的受控恢复。不得批量清零 attempts、改快照、删旧结果或无限重投。需要恢复更多历史时间段时，通过新的显式查询生成新快照。
6. 回滚应用时先停新控制处理器；新增数据结构保留，已生成水位/轨迹及审计不得删除。旧版应用继续读取原有公开接口。

## 冻结历史请求独立消费

常驻 projection-worker 分别运行 LIVE 和 HISTORY 两个串行循环，各自独立退避。LIVE 保持观测、业务投影、区间、片段重建、封存及事件转发顺序；HISTORY 只消费已有冻结历史请求，使用独立连接池，避免长片段重建导致查询队列长时间等待。`--once` 仍按原顺序执行所有阶段。

历史请求仍一次只领取一条，两个工作器通过现有 SKIP LOCKED、租约续期及 generation CAS 协作。独立调度不放宽 capturedAt、范围、快照或输入版本约束，不修改旧结果，不把 PENDING/PROVISIONAL 转成 COMPLETE。每条 SQL 仍受 30 秒上限约束；慢 SQL 本身可能失败，需要按日志单独定位，不能将独立调度视为所有历史请求均可成功的保证。

阶段超过 1 秒会输出 `historical_stage_timing`（阶段与耗时）；历史请求每次领取处理后输出 `historical_request_tick`（成功、结果与失败计数），不输出消息或连接信息。现场只需更新两个 projection-worker，保留其他容器、账号、配置及迁移。部署包必须包含已执行的正式 084 迁移及其原校验和；本次调度修复不新增迁移。
