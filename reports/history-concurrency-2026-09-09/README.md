# 085/086 实时重建与冻结请求评估交付

> 当前结论（2026-09-09 20:43）：WSGS 分仓修复后，有效历史轨迹 Finding 业务门槛已通过。真实结果仍为 PARTIAL / PROVISIONAL，保留一个轨迹缺口。GOWM 部署包与现场配置未再变更。

## 范围

仅修改 GOWM。085 增加一秒非滑动合并、同键互斥、单次候选物化、重建/封存续租；086 增加完整冻结请求评估证明和读取函数，允许经本次评估验证后复用旧轨迹。001–084 与上一部署包逐字节一致，见 predecessor-checksums.json。

工作器配置默认历史 2、重建 1、封存 1，各槽空闲才领取一项。独立有限池及退避，退出宽限 60 秒。SQL 预算仍为 30 秒。

## 验证证据

- dispatch.json：非滑动合并、运行中新证据、双设备并行、同键及封存互斥、过期重领/代际拒绝、续租/取消回滚、稳定身份不阻塞封存、耗尽任务不饿死其他设备、原哈希及最小权限。
- request-evaluation.json：旧轨迹复用、冻结上下文匹配、伪造证明/错范围/错代际/错输入拒绝、原子完成、旧结果不变。
- upgrade.json：084→086、重复执行，原账本、轨迹及角色密码保持不变。
- gateway.json：真实 PostgreSQL 与历史 Provider/Gateway 相关集成。
- unit-tests.txt、provider-readiness.txt、build.txt：相关单元/HTTP、类型和构建结果。

## 规模验证方法

隔离 PostgreSQL 18.6、PostGIS 3.6.4、MobilityDB 1.3.0。双设备各至少 20,000 点、至少 150,000 条时间解、20,000,000 条无关历史输入。大规模背景输入由已通过外键验证的元组复制；仅隔离造数事务暂时关闭触发器，提交后恢复 origin。正式负载、工作器及全部行为验证使用正常约束和最小权限角色。

10 分钟输入为每设备每秒一个有效位置，每设备每 10 秒一条历史请求（总 120 条）；两工作器均 H2/T1/F1。scale-plan.json 保存实际 ANALYZE/BUFFERS 计划；scale-result.json 和 scale-latencies.json 保存全程结果及原始延迟。

preliminary-load.log 是未通过验收的中途诊断运行，不能视为性能通过证据。该运行定位到无变化的轨迹身份 UPDATE 与封存 SHARE 锁互等，085 已改为仅绑定变化时更新；正式结论以最终 scale-result.json 为准。

before-final-optimization-scale-result.json 保存第二轮完整但未通过的结果：实时 P95 6.318 秒、领取 P95 73.104 毫秒，120 条全部完成。之后将重建排序预算固定为 16MB，关闭内部并行，保留完整的复合测量与上游外键链，消除两条单列外键的传递冗余检查。孤立观测与时间解仍被拒绝，见 dispatch.json。

## 上线边界

仅追加 085/086 并更新两个 GOWM 投影工作器和历史 Provider。保留关联容器、数据库、卷、密码、设备配置、来源和服务绑定；不执行初始化、不恢复耗尽请求。先 H1，再结合规模门槛和现场数据库余量决定是否升 H2。

部署包、现场校验及 SACS→WSGS 协调验收分别记录于后续章节。真实完整性状态必须保留，不能将队列完成当成业务验收。

历史预读取后续检查：before-prefetch-fix-scale-result.json 是门槛已通过（实时 P95 2.986 秒、领取 P95 77.362 毫秒）的 10 分钟运行，但有请求因 SQL 内部并行共享内存分配失败进入正常重试。后续修复为冻结版本输入先物化、测量及时间解按主键查询，并在历史运行时事务内关闭内部 SQL 并行。prefetch-result.json/prefetch-plan.json 记录新旧对照及真实规模执行计划；没有放宽 30 秒预算或冻结时间边界。最终交付运行须另行确认无此错误。

## 最终规模结果

完整 600 秒，1,200 个位置样本；实时可见延迟 P95 3.490 秒，历史请求领取 P95 69.944 毫秒；120 条请求全部第一次完成。SQL 错误、阶段错误、续租丢失均为 0。见 scale-result.json、scale-latencies.json、scale-error-audit.json 和 load-delivery.log。实际背景时间解 153,258 条、无关输入 20,000,000 条。

## sz-gowm 定向更新

正式迁移已追加至 086，原 001–084 账本校验通过；首次因已有事务锁触发 5 秒预算安全回滚，随后仅让两个目标工作器优雅退出，未终止其他连接，重试成功。三个目标均使用 release.json 的最终镜像，历史并发保持每容器 1（现场连接数约 89–90/100），重建及封存各 1。

site-verification.json：环境、挂载、依赖、角色密码与设备/来源/服务绑定保持不变，195 条原已耗尽请求未改动。其他 70 个容器均未重建。其中 69 个容器启动时间不变；sdar-benchmark-projector-1 维持原 ID/镜像，其同一错误在 19:15 已开始并导致自动重启，早于本次 GOWM 首次迁移。external-restart-evidence.json 保存前后相同 error 摘要，未操作该服务。不能把这项既有故障描述为本次所有外部服务健康。

site-diagnose.json 的十五分钟聚合包含旧积压，领取 P95 不代表新请求延迟。site-fresh-request-metrics.json 单独统计更新稳定后新建的请求。现场已出现评估复用成功；所有片段仍保留真实 PROVISIONAL，未伪造 COMPLETE/SEALED。

未运行账号、设备或采集初始化，未替换数据库、清理数据卷、改变来源绑定、恢复耗尽请求或清零尝试次数。仅仍可重试的请求由正常消费者处理。

回滚保留旧包和镜像，仅恢复发布目录的 override.before.json 后定向重建原三个服务；085/086 和新评估记录保留，不逆向迁移或删除历史结果。现场操作脚本及受保护基线保存在 release.json 指定的服务器发布目录，基线含敏感摘要，未复制进交付包。

## 首轮业务验收（19:57）：未通过

本次仅一次正常 SACS→WSGS 请求，于 2026-09-09 19:57:18–19:58:13 完成。GOWM 的历史节点约 1,478ms 返回真实轨迹：PARTIAL/TRAJECTORY_GAP、PROVISIONAL、9,806 样本、1 个缺口，已经不是 PROJECTION_PENDING。SACS 正常结束并持久化，公开结果 schema、hash 与引用租期验证通过。

WSGS 最终仍为 PARTIAL、0 Finding、REFERENCE_MISSING：公开产品只包含任务、轨迹和执行区间，漏补由任务间接解析出的主体 WORLD_OBJECT 产品；Finding 的引用完整性检查因此拒绝装配。本次 GOWM 实现、迁移、部署及性能交付完成，但整体有效 Finding 业务验收仍 INCOMPLETE，见 delivery-status.json、sacs-wsgs-acceptance.json、sacs-wsgs-readonly-diagnosis.md。

后续 WSGS 分仓修复应在生产结果装配时，将经过正常解析与验证的间接主体 WORLD_OBJECT 纳入公开引用产品，保持完整 ReferenceKey 和验证证据，并覆盖“用户只提及任务、由任务确定主体”的场景。不得删除 Finding 引用检查或伪造来源。本次仅修改 GOWM，没有在 WSGS 增加代码、补发请求或扩大到其他分析；其修复后需要再协调业务验收。

## 最终交付物

- 部署包：../../output/deployment/gowm-dev-server-0.7.1.tar.gz
- SHA256：7fb576e9b975b6b712380d27e62c35a9273bcd4a2ab8c2c5cf74504752e6bc11
- 镜像：gowm-dev-package-check:7fb576e9b975b6b7
- 镜像 ID：sha256:a691228b8288606aae3318467ce722d358d3f2198675c45af422079b5580425a
- 上线目录：/mnt/data/gowm-history-releases/7fb576e9b975b6b7
- 原部署包、原三个服务镜像及 override.before.json 已保留。

## WSGS 分仓修复后的最终业务验收（20:42）：通过

WSGS 在其独立授权的任务中完成主体产品接纳修复并更新其 API/Worker；本 GOWM 任务没有修改 WSGS，也没有额外操作 GOWM 容器。新的唯一一次授权请求于 2026-09-09T12:42:18.506Z–12:43:30.350Z，通过正常 SACS AG-UI→WSGS 路径执行。本任务核对了三份脱敏证据的一致性，并将原字节副本保存在 wsgs-subject-fix-acceptance/，附 SHA256SUMS.json。

有效历史轨迹 Finding 门槛通过：1 个 HISTORICAL_TRACE、4 个公开引用产品、0 个未解析提及、0 个公开阻塞 gap。主体已 ADMITTED，验证 VALID；Finding 的唯一主体与接纳产品精确关联，证据关联正确，任务/主体及 Finding 租期在该次响应时有效。原历史主体版本没有被覆盖。检查点完整性、schema、resultHash、SACS 正常结束/持久化快照和清理通过；独立语义断言 16/16 通过。

真实轨迹保留 9,806 样本、1 个缺口和 PROVISIONAL；Finding 与整体结果均正确保持 PARTIAL。原通用传输观察 harness 仍为 INCOMPLETE/OBSERVED，没有改写成全面 PASS。本结论限定于本计划要求的有效 HISTORICAL_TRACE Finding，不扩大到排名、道路、自由时间窗、设备执行或 SEALED/无缺口声明。

首次未通过的请求、报告和 delivery-status-before-wsgs-fix.json 均保留。两轮各经一次授权请求，没有将失败结果改写为成功。本次更新仅补齐交付记录；GOWM 包 SHA256 仍为 7fb576e9b975b6b712380d27e62c35a9273bcd4a2ab8c2c5cf74504752e6bc11，现场每容器历史并发仍为 1。
