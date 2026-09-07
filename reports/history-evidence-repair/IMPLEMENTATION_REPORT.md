# 历史原始证据与 UGV 接入修复：本地实施记录

日期：2026-09-07。分支：`codex/history-evidence-repair-v0.1`。
基线：`77f7df4b3db10920a95342450381da4a627724c1`，仅作溯源。
状态：本地实现与下列验收完成；**不是现场真实数据验收或发布批准**。

## 实施范围

| 项目 | 实现位置与责任 |
|---|---|
| P1-1 | GOWM migration 071、073、历史 runtime/provider：固定输入集合验签、v2 分页原始采样、三种计数和新投影身份；分析仓库 shared adapter、三 Provider snapshot/implementation identity：不再枚举压缩节点作为样本 |
| P1-2 | migration 072：真实 clock/datastream/producer 驱动的幂等 UNKNOWN 初始化和受控补齐；finalizer 拒绝不相容的 clock 关闭证据 |
| P1-3 | mapper v2：SPEED/GNSS 同车辆和 session，旧 v1 mapper 保留；QoS 策略进入持久 mapper context，活动会话/积压拒绝换 context |
| P2-4 | migration 074、services/history-auto：专用角色、完整 resolver 输入签名、事务入队/检查点、Scope 锁、退避及默认 Compose 服务；分析外层改为使用原生服务，不再附加旧 command/build |
| P2-5 | config/app/repository/mapper、Compose、.env.example：speed-only QoS0 开关、实际 QoS/策略谱系和独立计数；未授权 QoS0 保留审计但拒绝进入投影 |
| P2-6 | migration 075、binding-snapshot-index.ts、正式 migrate runner：按定义复用已有索引；非事务 CONCURRENTLY 在线步骤；保留分析侧 T4 SQL 改写 |

没有批量减少或改写历史绑定：原观测幂等返回路径已经避免同一观测
重写绑定；不同观测证据继续追加。分析仓库在开始时已有大量未提交改动，
本轮仅在相关 adapter/provider/deployment/test 文件做增量修改，没有清理其工作区。

## 已完成验收

- PostgreSQL 18.6、PostGIS 3.6.4、MobilityDB 1.3.0，自建隔离 Docker 数据库；
  全新库 001–075 迁移成功，001–068 冻结校验通过。
- 正常 ObservationRepository → ProjectionWorker → 专用 scheduler 角色 →
  历史队列/物化链路：197 条独立静止原始观测形成 2 节点几何；首次 UNKNOWN
  使原生调度产出 PROVISIONAL。没有调用 history.get-trajectory 触发调度。
- v2 每页 50 条恢复共 197 条稳定 measurement ID，验证 observation/time-solution/
  tracklet 谱系、digest、一致性、晚到隔离、错误游标和跨 Scope 拒绝。
- 单独生成 v1 旧语义修订：sample_count 仍为 2；v2 从它恢复 197 条，保留
  原 contentHash，恢复旧几何开区间末端的真实采样。新旧两修订均通过 v2 JSON Schema。
- 分析真实 PostgreSQL adapter：恢复 197 条、STOP=1；固定反例的 402 条合成指标
  中 398 对齐、4 范围外拒绝。约 299.909 秒间隔和 15ms/0.938m 跳变仍分别
  触发时间断点和 PLAUSIBILITY_BREAK，没有放宽阈值或人工插值补样。
- 分析相关 6 文件 60 项回归通过；部署包构建逻辑 18 项通过；两个仓库的
  `npm run check` 通过，GOWM `build:runtime` 与环境模板审计通过。
- GOWM 历史/mapper/config/finalization/redelivery 最终 7 文件 45 项通过，
  包含新增 QoS0 四态持久接收门禁用例。
- 环境模板覆盖 205 个 Compose 变量并审计 178 个 runtime 变量。历史读取角色
  无 UNKNOWN 初始化执行权；专用 scheduler 可以实际入队而不持有管理员连接。
- MQTT 持久化真实数据库 4 项回归通过，覆盖 ACK/重发、持久 mapper context
  和不可变 outbox。首次使用复制的历史测试库因已有 source 属于另一 Scope 被正确
  拒绝；改为从零迁移的 MQTT 专用空库后通过，没有放宽来源隔离约束。

最终本地 v2 示例（仅隔离测试，不是原现场 wrf）：

- reference：`wrf_863ad7e3cc9d46349a11f4d95a753ff2@1`
- contentHash：`sha256:560daa323f81103a2f80b28b793d1d283b91fddc186b65114c8359cac169105b`
- evidenceHash：`sha256:c510730119b89ffc6cea93acd7ebd89666f74232dbf8faf5aab4655949693ad6`
- 状态：PROVISIONAL；evidenceSampleCount=197；geometryNodeCount=2。

## 尚未声称通过的验收

交接 JSON 只有压缩结果和统计，没有完整原始 197 条位置与 402 条指标的可重放
源记录。因此上述数量反例是**合成原始观测经真实数据库执行**，不能替代现场
`wrf_290b64c4248d4ffb898dacdbcd9e6b1d@1` 的重放或其 STOP 判定。

仍需后续授权环境完成：原现场两个假断点消失与全部真实指标对齐、事件时间/
接收时间/重发的 15ms 异常调查、真实大表 EXPLAIN/BUFFERS 和超时预算验收、
真实 broker 排空升级/重连/故障恢复、新旧联合包完整 Provider/Gateway 联调和
调度权移交。约 412ms 旧观测值没有被当作本轮性能保证。自动调度多实例/时钟
版本演进等完整故障矩阵也没有被合成单链路替代为 PASS。

既有五项获准放行事项保留原状态，没有改写为 PASS，也不用于豁免本轮缺项。
未访问或修改远程环境，未提交/推送、未重建或覆盖旧发布归档，未回填历史。
本任务自建 `gowm-history-repair-test-20260907` 容器已停止，合成测试库和镜像保留供复查。
下一阶段交付顺序仍是 clean commit → GOWM 包 → GDPS 联合包 → 分析动态发现
正式包与部署时精确锁。运行合同、默认配置和升级/回退顺序见
`docs/history-evidence-v2.md`、`docs/history-evidence-upgrade-runbook.md`。
