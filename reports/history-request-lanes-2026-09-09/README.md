# 历史请求消费延迟修复及现场证据

日期：2026-09-09。范围：仅 GOWM 独立消费调度；不恢复失败队列、不改旧轨迹或任务事实、不伪造完整水位。本次不是 SACS→WSGS 端到端业务 PASS。

## 精确关联的业务请求

- groundingId SHA256：`db91c4f43f2fc06676bf03fc924c0e07355617674987bc3c79cc9edc37183c5f`
- WSGS resultHash：`sha256:e7d293a9edb3fd7aa737bfb98c769d941aaa28d0dd65e62be07e7f5070e98677`
- semanticRequestHash：`sha256:4d478177325b690f18158ca33dede96b50b2addc3f4d3d79efbf2e09a95a2b27`
- queue snapshot_hash / requested_snapshot.manifestHash：`sha256:8f5958c5e6992493c94ab44d5947ae11aae7615e390d5dd2e585d276e0216801`
- 冻结 capturedAt：`2026-09-09T08:30:19.436Z`；区间 revision=2。

WSGS 任务以自身 canonicalSha256 验证解密检查点完整性后，从 submission.plan.nodes[1].inputs 与 Node_1 的实际区间输出重构语义身份。语义摘要与完整 subjectReferenceKey、executionIntervalReferenceKey 的规范摘要均匹配 GOWM 队列。terminal.result.nodes[1].effectiveSnapshotBeforeHash 与上述队列快照摘要完全一致；节点执行后的快照摘要为 `sha256:6fdd76b283c8b38fc8085ac77fe41c0eca6b97e9342f89f878a1dae81a887ba1`，因此终态汇总快照不同并非关联失败。原始业务标识与轨迹坐标未公开。

该请求 queued_at=`08:30:20.363928Z`，正常 processed_at=`08:46:21.796956Z`，attempts=1/generation=1；在本次工作器更新之前已完成，不能将这次完成归功于新代码。不是消费者未启动，而是约16分钟消费延迟。

产物：PROVISIONAL，9806个证据样本、2个序列、1处真实缺口，temporal_coverage_ratio≈0.9999991429。revision.content_hash 的 MD5 摘要为 `77483e4cd22e6553f48bf93190090c49`。未改写该产物。原查询为 LATEST + EXECUTION_ENVELOPE，不包含自由起止时间窗。队列完成并不代表 WSGS 已对该产物形成有效轨迹 Finding。

## 已修复的原因

原工作器将观测、业务投影、区间、TRACKLET 重建、封存和历史请求顺序放在同一 tick。PROJECTION_BATCH_SIZE=200，但历史请求阶段为保护租约只领取一条。现场两工作器反复停留在长 TRACKLET SQL 或历史裁剪 SQL（超时约31秒）；后续冻结历史请求必须等待前置实时工作及整轮结束。代码控制流及持续活动 SQL 证明了这条排队依赖；不能据此把所有延迟都归因于单个 SQL。

常驻工作器现在运行两个独立串行循环：LIVE 保持实时投影阶段顺序，HISTORY 使用独立上限2连接的池消费冻结请求。两个循环有独立退避；关闭时停止继续领取并等待循环结束。HISTORY 仍一次领取一条，使用现有 SKIP LOCKED、续租、代际 CAS、30秒单SQL限制及冻结输入约束。`--once` 保持原完整顺序。增加阶段耗时和历史请求计数日志，不输出连接密码或消息内容。

## 验证与交付

- 11项工作器及退避单元测试通过，包括实时重建被阻塞时连续消费历史请求。
- TypeScript类型检查、构建和diff空白检查通过。
- 隔离真实 PostgreSQL 18.6/PostGIS 3.6.4/MobilityDB 1.3.0，正式迁移001–084；history-queue-worker验证通过。新增实时阶段等待门控下的真实冻结历史物化验证，保留双消费者续租、回收、取消、原子CAS和旧快照结果不变检查。隔离测试容器已删除。
- 部署包及镜像源码一致性、入口、校验和、权限和可重复打包检查通过。
- 包：`output/deployment/gowm-dev-server-0.7.1.tar.gz`
- SHA256：`b13e4365a88656ee64b95e38afb45a43143235f61916a2e5b6e5581527880542`
- 镜像：`gowm-dev-package-check:b13e4365a88656ee`
- 镜像ID：`sha256:839362a5900762f2fe122506868af323a610c0bdadacf7f769a32ffc21605dfd`
- 旧包保留于 `output/deployment/previous-gowm-dev-server-0.7.1.Zk7bCW`。

## sz-gowm 定向上线

两个 projection-worker 于 `08:56:09Z` 切换到上述镜像。仅执行明确目标的 `compose up -d --no-deps --no-build`，未执行安装器、迁移、账号初始化、数据库或队列恢复。已核对001–084迁移校验和，新包完整保留084。

远端包、基线、旧覆盖配置、操作脚本及核对记录位于 `/mnt/data/gowm-history-releases/b13e4365a88656ee/`。既有 compose 覆盖文件只调整两个服务镜像及构建来源。有效环境、挂载、网络、命令及声明依赖一致；原环境文件、主档、端点、7条流、服务绑定和既有数据库角色密码摘要一致，数据库容器及SDAR扩展镜像未替换。

基线73个容器中，2个为本次工作器；65个其他容器ID、镜像、启动时间不变。另6个SDAR Benchmark容器在09:02:22Z由《集成项目部署到 sz-gowm》任务（01a08476-61b0-7700-b427-f5568897057c）独立替换，已读取该任务核实其部署日志。本任务未操作这些容器，不将全现场变化误报为全数未变。projector原有重启现象和该任务后续部署单列，不判断为本次GOWM更新造成。

上线后观察到 `gowm-historical-request-worker` 和原实时历史工作连接同时执行不同阶段。至约08:59:30Z，已有8条请求在新工作器上线后正常COMPLETED；当时default快照为COMPLETED=147、QUEUED=4、RUNNING=2、FAILED=73。计数随正常采集变化，不表示旧失败均已解决。

## 独立未修复问题与验收边界

1. **旧轨迹复用的23514冲突。** registerInTransaction 按同语义和content_hash复用旧revision，但正式067完成函数要求revision.created_at > queue.captured_at。较晚冻结请求复用较早同内容revision会违反该条件。只读检查8条错误请求具有相同身份及较早revision，代码路径解释了冲突；没有删掉时间条件或改旧revision。本次精确关联请求不受此错误影响。后续需设计请求级复用证明/分析快照关联及正式新增迁移，保留冻结完成约束。
2. **旧slice超时。** 现场mobility_tracklet_input估计1750万行、总5.7GB，observation_time_solution约13万行。5秒预算的只读EXPLAIN（未执行ANALYZE）对代表性16316样本片段显示：时间解顺序扫描估计仅1行，作为Nested Loop外侧；内侧是input Bitmap Heap Scan（估计4940行）。这可能反复扫描原始输入，和小规模验证计划不同。该片段不是已精确关联的失败请求输入，尚无实际loops/buffers证据，因此不宣称所有旧超时根因已最终证明。后续应在隔离的大基数数据上验证先物化版本/段内证据、按time_solution_id定向查找等优化，保持边界/样本语义及30秒预算。

独立消费已上线，但不能承诺新的端到端请求一定得到有效Finding。WSGS等待原因修复、复用契约与现场规模裁剪风险仍需分别处理；不得通过重发业务请求、清零attempts、改水位、补造完成或替换旧快照来获得PASS。本次未提交任何SACS→WSGS新业务请求。
