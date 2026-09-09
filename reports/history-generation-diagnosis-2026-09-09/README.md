# 历史轨迹生成只读诊断（2026-09-09）

现场：sz-gowm，gowm-analysis-dev-d2bf0ea98e-postgres-1 / gowm，正式迁移至 082。采样时间约 14:17–14:20（Asia/Shanghai）；采集持续运行，计数会增长。仅执行只读查询、日志读取和 EXPLAIN，未重投、改数据、改配置或部署。

## 1. 有效视图显示零：事务数据范围未设置

已在同一个只读事务中直接复现：

- current_data_scope_key() 为空时，gowm_history_v1.tracklet_version_effective 和 historical_trajectory_effective 均为 0。
- 调用 set_data_scope('default') 后分别为 3677 和 4。
- 基础表有 1 个 mobility_tracklet 身份、约 3677 个版本、29 个历史轨迹修订、4 个历史轨迹身份。

两个视图均显式过滤 data_scope_key=current_data_scope_key()。即便使用管理员查询，视图 WHERE 条件仍然生效。set_data_scope 内部 set_config(...,true) 只在当前事务生效，不能在自动提交连接中单独运行一次后再另起事务查表。

```sql
BEGIN READ ONLY;
SELECT gowm_history_v1.set_data_scope('default');
SELECT count(*) FROM gowm_history_v1.tracklet_version_effective;
SELECT count(*) FROM gowm_history_v1.historical_trajectory_effective;
COMMIT;
```

这证明上述视图的零值可以由会话范围直接解释；未取得用户原始 SQL，不能断言其查询一定完全相同。3677 是版本数，不是独立设备/会话片段数。

## 2. 新历史轨迹生成确有性能阻塞

- 最后历史修订写入：2026-09-09 03:20:26.902159Z（北京时间 11:20:26），其数据末时间 03:16:15.916Z。
- 约 14:17 采样：历史队列 29 COMPLETED、83 FAILED、2 RUNNING、8 QUEUED；所有 FAILED 的 last_error 均为 canceling statement due to statement timeout。其中 35 条已用满 10 次尝试，其他 FAILED 仍可能按重试规则领取。
- 片段仍持续生成，当前头约 14418 原始样本，起于 01:45Z；第二段约 14071 样本，延续至 06:18Z。同一 airport-run-001:ugv 会话持续增长。
- 两个 worker 的活动 SQL 均捕获在 PostgresMobilityDbTrajectorySlicer.slice 的 evidenceSamples 分支。
- 源码 packages/historical-trace-runtime/src/trajectory-repository.ts:435 普通 CTE source 先 atTime(segment.trajectory, span)，计数子查询再逐样本 atTime(sliced, phenomenon_time_estimate)。
- 服务器 EXPLAIN VERBOSE（未 ANALYZE）确认 CTE 内联：observation_time_solution 全表顺序扫描的 Filter 是 atTime(atTime(segment.trajectory,span), solution.phenomenon_time_estimate) IS NOT NULL，之后才按 time_solution_id 做 Hash Join。即整个时间解表的候选行反复执行长轨迹裁剪，不只是选中片段的输入样本。
- 角色及 configureLocalExecutionBounds 明确将单 SQL 限为 30 秒；这是 SQL 性能问题，不能用延长租约解决，也不应直接放宽预算。
- history-auto 日志仍持续 SCANNED/queued/pending，存在 9 个候选；它只跳过 QUEUED/RUNNING，对 FAILED 在下一次输入解析时可能生成新冻结请求。变化中的 WORLD_OBJECT 版本、片段版本使请求签名变化，旧失败任务与新任务共同消耗工作器容量。

建议后续修复：确保裁剪只算一次，先限定当前 tracklet/version/segment 的输入及合法时间边界，再计算原始样本计数；保留原始证据数量、开闭边界、缺口及零原始样本片段语义。对自动调度的失败检查点实施有界退避和在途控制，保留旧请求冻结快照及独立审计。用同规模数据验证 30 秒内完成后再处理积压；此次没有进行慢查询复跑或队列恢复。

## 3. SEALED 为零有独立的水位原因

所有片段/历史轨迹修订当前为 PROVISIONAL。pipeline_watermark_revision 只有一条 UNKNOWN，closed_through_event_time 为 NULL；片段 finalization reason_codes 包含 WATERMARK_INCOMPLETE、WATERMARK_BEHIND_TRACKLET，部分还有 TRACKLET_REBUILD_PENDING。

packages/historical-trace-runtime/src/tracklet-projection-repository.ts:120 的 evaluateTrackletFinalization 要求各流 COMPLETE 且关闭时间覆盖片段末时间，才允许 SEALED。UNKNOWN 初始化不能充当完成证据。当前 9 个任务区间均 PROVISIONAL（7 CLOSED、2 OPEN）；任务结束也不自动证明来源数据完整。

PROVISIONAL 并不等于无效或不允许生成；已有 29 次历史修订均证明其可以产生可查询的部分结果。若统计只计 SEALED，会合法得到 0。需要上游正式完整性水位及关闭语义才能封存，不能将 UNKNOWN 人工改为 COMPLETE 掩盖问题。
