# 历史 Provider 快照资源修复（迁移 080）

现场 `history.get-trajectory` 的 `PROVIDER_NOT_READY` 来自入队函数 SQLSTATE 23503：Gateway 冻结的 `gowm:wrf_*` 被直接用作数据库中的原始 `wrf_*` 主键。容器健康检查只探测读取视图，因此不能代表某个查询的业务可用性。熔断后的 `CIRCUIT_OPEN` 是暂时不可用，不表示操作未注册。

080 保留 067 的权限、范围、捕获时间、冻结身份和幂等检查，仅对已知命名空间解码查找标识；原始快照 JSON 和哈希仍原样持久化。工作器同步解码查找副本，逐项验证上游任务算法与轨迹算法配置，避免混淆两者。原始无前缀的历史队列仍兼容。

另将轨迹修订的原始样本数约束与 073 的分段约束对齐，允许纯插值切片的零原始测量；Provider 明确返回 `NO_DATA / NO_TRAJECTORY_POINTS`，不能作为实测成功证据。此次不重写既有修订。

## 升级顺序

1. 使用最新正式部署包及其校验和，保留现有 `.env`、Compose 覆盖文件、数据库与数据卷。组合部署必须保留原项目名和网络。
2. 暂停该项目的 `world-platform-projection-worker`，防止旧工作器继续认领任务；不要停止 GDPS、GSAP 或清空队列。
3. 用新包镜像运行现有 `migrate` 服务（`docker compose ... run --rm --no-deps migrate`），由正式迁移工具执行到 080 并核对迁移账本。
4. 仅将 `historical-trace-provider` 与 `world-platform-projection-worker` 切换到同一新镜像（`up -d --no-deps --no-build`）。组合部署用明确的服务镜像覆盖，避免重建或替换业务消费者。
5. 核对两个容器的镜像摘要、Provider 健康、队列状态及原始数据库错误。用新 Gateway 请求验证实际业务可用性，保留原 120 秒预算、签名、身份与快照校验。旧失败 Gateway 作业保持不可变，不通过改写旧作业制造成功。
6. 对冻结 capturedAt 后才生成的投影，新请求才可看见；`PROJECTION_PENDING`、`NO_DATA`、`PARTIAL` 均须如实报告。等待熔断恢复后再进行 WSGS 场景资格验证，不能激活未通过候选。

验证入口：`validate:v07-history-queue-worker` 使用当前正式迁移和实际服务角色，覆盖带命名空间快照、未知命名空间/缺失引用拒绝、入队幂等、租约恢复与冻结快照不变；`validate:v07-history-gateway` 验证真实 HTTP Gateway→Provider、跨范围拒绝及旧快照重放。冻结迁移 067–079 不修改。

## 后续 PENDING 重评修复（迁移 081）

五个现场请求曾复用同一条早先的 PENDING，其中 CROSS 的原冻结输入已经 READY。Provider 现在对 PENDING 重新走精确冻结请求的受控入队；不同 capturedAt、快照哈希、区间修订产生不同请求，同一冻结请求仍由数据库唯一键去重。已落库的有效轨迹不再被旧 PENDING 覆盖。旧队列、旧 outcome 与 Gateway 作业不改写。

081 增加按区间修订筛选的历史读取重载，先筛选精确修订再选择 as-of 最新行，避免区间更新后复用旧 outcome 或错读旧轨迹。原 SQL 函数签名及公开 Provider Schema 保持兼容。升级执行正式 migrate 到 081，再仅更新 historical-trace-provider；投影工作器运行代码未改变，无须替换其他服务。

真实冻结时点等待与代码缺陷分开：TRACE/MAP/STOP/RANK 当时缺少所选 tracklet 的 finalization；这些旧快照不会通过等待后读入新证据而变成成功。新快照可以重新评估，但 READY、PROJECTION_PENDING、PARTIAL、NO_DATA 均不等同于高级分析通过。

## 工作器租约修复（迁移 082）

历史轨迹物化按单任务认领执行，等待任务保持 QUEUED，不提前消耗租约。082 提供仅当前 worker/generation 且尚未过期时可调用的续租函数；原完成函数的过期拒绝与原子提交不变。生产工作器使用独立小连接池续租，长 SQL 不占用续租通道。失租、续租失败或进程取消会阻止后续 SQL 和提交，已在运行的 SQL 仍受既有 30 秒单语句上限约束，事务可回滚；不改变 Gateway 的 120 秒预算。

本次升级先枚举所有连接同库的 GOWM 工作器，停妥旧执行者，运行正式 migrate 到 082，再将 projection-worker 和 world-platform-projection-worker 同步替换为新镜像。现场两者此前分别运行旧版与已修复版本，不能遗漏基础工作器。Provider 081 版本和其他服务保持运行。验证包括单工作连接上跨多个租约周期的真实 pg_sleep、排队任务未被认领、续租连接失败、执行中取消及旧执行者与新认领并发；不得通过延长 complete 接受期限、清空队列或改写冻结请求来绕过验证。

已耗尽重试的队列不得全量重置。仅在管理员确认受已修复缺陷影响、保存原运行元数据及冻结输入摘要后，才可对指定无结果的失败队列做有审计的有限恢复；必须改变 generation 隔离旧执行者，保留冻结 query/snapshot/capturedAt，恢复前后核对摘要一致。
