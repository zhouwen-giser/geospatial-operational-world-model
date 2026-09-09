# 实时重建、受控并行与冻结请求评估（085/086）

## 运行方式

位置证据仍通过既有触发器写入 dirty queue，不在接收事务中重建轨迹。085 为范围、来源、目标、采集会话、分析空间及规则配置计算调度键。首条更新确定约一秒后的可领取时间，后续更新不延后时间；运行期间新增证据保留到下一轮，包括旧任务过期重领的情况。同键只允许一个有效 RUNNING 租约，其他设备或会话可以并行。

重建在单条 SQL 中物化一次候选集合，复用该集合生成几何、统计、首末点、内容哈希、输入与真实缺口。仍追加完整不可变版本。已有同内容版本不回退历史头指针。重建、封存和历史请求使用独立连接池及续租池；租约失败或进程退出后阻止后续 SQL 和提交，正在执行的 SQL 保持既有 30 秒预算并回滚。正常退出停止领取并等待事务退出。

长运行工作器有 CORE、TRACKLET、FINALIZATION、HISTORY 独立循环。每个执行槽空闲后只领取一条；CORE 保持观测、业务投影、区间和事件转发顺序。`--once` 保留原顺序与批量行为。每槽独立退避。

重建函数使用事务内 16MB 排序预算；历史运行时事务、重建与谱系判定关闭内部 SQL 并行，由工作器槽位控制并发。085 保留输入的复合测量外键及测量到观测、时间解的已验证外键链，移除输入上两条传递冗余的单列外键，避免每个完整版本对每点重复验证相同关系；孤立或不匹配的观测/时间解仍由复合外键拒绝。迁移先检查这条约束链，缺失即拒绝执行。

两个工作器的容器退出宽限为 60 秒，覆盖正在执行 SQL 的 30 秒预算及回滚退出。Provider 就绪检查同时要求 086 的评估读取函数可用，避免新镜像在迁移缺失时接收业务查询。

| 环境变量 | 默认 | 范围 | 每个容器作用 |
| --- | --- | --- | --- |
| `HISTORICAL_REQUEST_CONCURRENCY` | 2 | 1–4 | 冻结历史请求执行槽 |
| `TRACKLET_REBUILD_CONCURRENCY` | 1 | 1–2 | 不同片段键重建槽 |
| `TRACKLET_FINALIZATION_CONCURRENCY` | 1 | 1–2 | 封存评估槽 |

两个容器使用默认值时，历史请求最多四条同时执行。上线先显式设为 1，性能门槛通过后再设为 2。提高并发不改变 SQL 超时、范围检查或同键互斥。

## 旧轨迹复用与请求证明

历史输入预读取也先物化冻结版本所需的输入，再按主键定向读取测量及时间解，防止并行哈希连接扫描无关历史输入。

原 `23514` 来自旧版本创建时间早于新请求冻结时间。086 保留旧完成函数，为新消费者引入不可变 `historical_request_evaluation`。每次消费重新解析该请求的完整冻结快照；对象、精确区间修订、来源、配置、输入及内容均匹配才可复用。

受控函数为本次请求追加新的分析记录及输入关联，评估记录冻结队列、代际、请求及快照摘要、版本、分析、输入和内容摘要、领取及评估时间。证明与队列完成必须在同一事务提交。错范围、错代际、不匹配输入/内容/固定资源及未完成队列的证明不能提交。原轨迹、分析、快照和历史头保持不变。

Provider 优先按完整查询 JSON 和完整快照匹配已完成证明，再沿用既有查询路径。输入冻结时间与结果计算时间分开：该请求在冻结后完成的计算可被读取，不读取其他快照的最新结果。公开 `history.get-trajectory` 输入输出及轨迹引用不变；返回的分析引用对应请求评估。`NO_DATA/PENDING` 继续使用原约束。

## 验证命令

只使用隔离 PostgreSQL。`DATABASE_ADMIN_URL` 指向允许创建、删除临时数据库的测试实例。

```sh
npm run build
npm run validate:history-dispatch
npm run validate:history-upgrade
npm run validate:v07-history-queue-worker
npm run validate:history-concurrency-scale
```

大规模验证含双设备各至少两万点、十五万条时间解和两千万条无关历史输入，保留实际 EXPLAIN ANALYZE/BUFFERS。持续十分钟、每台设备每秒一条位置证据，每台设备每十秒一条受控历史请求（共 120 条，比每十秒一条总请求更高）。门槛：可见延迟 P95 ≤5 秒、等待领取 P95 ≤2 秒、裁剪 SQL <30 秒，所有请求正常完成。测试失败不能授权提高现场默认并发。

## 追加迁移和定向更新

保留旧包及目标服务的镜像、实际环境、网络、挂载、依赖条件、设备/来源/采集流/服务绑定、数据库镜像和角色密码摘要。与其他任务串行协调。完整安装器仍用于全新安装；已有现场使用以下专用入口，环境沿用现有数据库连接及迁移参数，不生成新账号。

```sh
node dist/scripts/history-hot-migrate.js --check
node dist/scripts/history-hot-migrate.js
node dist/scripts/history-hot-migrate.js --check
```

入口只接受连续的 084、085 或 086 基线，校验全部既有迁移；085/086 SQL 和迁移账本原子提交，重复运行不写旧账本，不调用角色或设备初始化。`DATABASE_URL`、`ANALYSIS_SRID` 和 `TRACKLET_MAX_*` 必须沿用当前部署值。

先追加迁移，再逐步替换 `projection-worker`、`world-platform-projection-worker` 及现场历史 Provider 的对应服务。对现场原 Compose 文件组合，仅覆盖这三个服务的镜像/构建目录及两个工作器上述并发参数。使用明确服务名和 `up -d --no-deps --no-build`。两个工作器先取历史并发 1，重建/封存均为 1。

不运行 `down`、全栈重建、账号初始化、设备初始化、卷清理、镜像清理或失败队列恢复。SMPP、SDAR、GDPS、GSAP 及数据库依赖继续使用原服务、密码和绑定。已耗尽重试的旧请求保持原状；仍可重试的请求正常消费。

观察范围内的阶段耗时、队列等待、有效并发、租约失败和复用情况：

```sh
GOWM_DATABASE_URL='现有管理连接' node dist/scripts/history-diagnose.js '明确的数据范围'
```

诊断事务设置数据范围，输出计数、最近十五分钟评估/复用与 P95、当前有效 RUNNING 数及错误存在标记，不输出密码或完整消息。运行日志包括 `projection_concurrency`、`historical_stage_timing`、`tracklet_rebuilt`、`tracklet_finalized`、`historical_request_prepare`、`historical_request_completed`、`projection_lease_lost`；失败附队列/代际、SQLSTATE、耗时和固定 reason 分类（例如 REQUEST_EVALUATION_SNAPSHOT_MISMATCH），不输出任意异常正文。CLI 需要读取诊断表的既有管理账号，业务只读服务不因此获得直接表权限。

当正确性及性能门槛通过且共享数据库压力可接受时，仅将两个工作器历史并发升至 2。持续超时或数据库压力恶化时降回 1。重建、封存默认保持 1。

## 回滚及业务验收

回滚仅恢复以上服务的旧镜像和并发覆盖，保留 085/086 及评估数据；不逆向迁移、不删评估、不改旧结果，不清零尝试次数。旧消费者可调用原完成函数，但旧版本复用限制也随旧代码恢复；必要时暂停历史领取并保留队列等待后续修复。

最后协调一次正常 SACS→WSGS 路径，取得有效轨迹 Finding，记录请求、快照摘要、评估分析引用和真实完整性状态。`PROVISIONAL/PENDING`、真实缺口、重置水位 `RESET_ACK_ACCEPTED_COMPLETE_V1` 保持原义。仅队列完成、存在轨迹或测试通过都不能代替业务验收。

## 部署包交付校验

使用 `bash scripts/package-dev-deployment.sh --force --verify-image` 生成包。脚本在暂存目录生成 `scripts/history-release-manifest.json`，记录连续 001–086 正式迁移、历史运行时源码和接入说明的 SHA-256，以及对应编译入口。清单不含现场配置、密码或测试报告；没有生成时间字段，相同内容可重复打包。解包后可执行 `node scripts/history-release-manifest.mjs` 校验源码清单。镜像校验另外核对全部迁移字节和历史运行时编译产物，并沿用源码与镜像一致性检查。

全部校验成功后才替换输出包，旧包保留在 `output/deployment/previous-*`。生成清单及镜像验证不会连接现场或执行初始化；已有部署仍按上述专用追加迁移和串行更新步骤操作，历史并发先使用 1。
