# 修复交付验证

2026-09-09；仅本地 GOWM 代码与部署包。本次没有连接、更新 sz-gowm，也没有恢复或改写现场队列。

- 裁剪：MATERIALIZED 固定裁剪结果；以 tstzspan/getTime 时间集合统计真实样本，消除逐时间解重复 atTime 长轨迹裁剪。
- 调度：在途及尚可重试 FAILED 请求不创建并行替代请求；耗尽重试后保存旧签名并退避，同签名抑制，新签名接续，不在入队时清零失败计数。
- 控制：独立 /sim/reset_ack QoS 1 接入，复用 inbox/packet slot/PUBACK 持久化流程，新增 083 正式迁移和受控角色；成功回执按 RESET_ACK_ACCEPTED_COMPLETE_V1 接受可能丢包的完整性边界。保存接收前缀、策略、源时钟、水位来源；普通历史角色不能写水位。
- 操作指南：docs/HISTORY_RESET_WATERMARKS.md；只读诊断 scripts/history-diagnose.ts。

验证结果：

- npm run check、TypeScript 类型检查、SQL AST 检查通过。
- 相关历史/调度/回执单测 37 项，MQTT 合同、重投、配置和设备 actor 单测 28 项通过。
- 正式 history-evidence-ci：全新 001→083、保留 069→083 与迁移重复执行通过；197 个原始证据样本与 2 个几何节点区分、旧版读取、迟到输入和旧结果稳定性通过。
- 水位真实 PostgreSQL：有效回执生成 3 条流水位；任务 source authority 水位、重复、冲突、乱序、retained、禁用设备、目标不匹配、inbox 排空、时钟不支持、范围隔离、最小权限及开放任务不误封存通过。
- 真实 PostgreSQL 18.6 / MobilityDB 1.3.0，使用专用 gowm_history_worker_service 角色：15000 点、70000 条时间解，单次裁剪 78.56 ms；零原始样本、内部闭边界、末端开边界、跨范围检查通过。此数值为本地合成数据验证，不是服务器上线性能承诺。
- 额外只读时间成员对照：21 个开闭边界、重复时间、缺口及无交集案例，旧 atTime 与新时间集合判断差异 0。
- queue-worker 真实 PostgreSQL：双工作器、旧代际拒绝、同冻结请求去重、待处理重新评估、续租失败停止旧执行者、取消阻止提交及原子提交通过。
- 部署镜像构建、源码/运行时身份、非 root 迁移可读、包校验和、排除规则、权限及重复打包一致性通过。

最终部署包：output/deployment/gowm-dev-server-0.7.1.tar.gz，约 3.7 MB。
SHA256：64760748270d1e522c6eb4b3b04da8a38d1f80c99fcac89d54bcd9161e28175c。
旧包已保留。仿真 UI 重置没有回执发布，不触发本策略；仅现有 MQTT reset_ack 路径触发。
