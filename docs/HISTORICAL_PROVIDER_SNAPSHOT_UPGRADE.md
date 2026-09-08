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
